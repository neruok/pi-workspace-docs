/**
 * workspace-docs — publication of compiled Markdown to disk (D-9).
 *
 * Publication is independent of rendering: `compile()` produces bytes and this
 * module compares them against the bytes recorded for each output path. It
 * never overwrites or adopts a file that changed after it was published, it
 * records durable per-path intent before every replacement, and it recovers an
 * interrupted replacement on the next run. One failing path is reported without
 * rolling back the others.
 *
 * Publication state is derived metadata, never canonical content. The store
 * remains authoritative.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Diagnostic, PublishOptions, PublishOutcome, ReconcileEntry } from "./model.ts";

const STATE_VERSION = 1;
const STATE_FILE = "publication.json";
const TEMP_SUFFIX = ".workspace-docs-tmp";

interface PublicationRecord {
  hash: string;
  documentId: string;
}

interface PendingIntent {
  /** Recorded hash before the interrupted replacement; null when no record existed. */
  previousHash: string | null;
  intendedHash: string;
  documentId: string;
}

interface PublicationState {
  version: number;
  files: Record<string, PublicationRecord>;
  pending: Record<string, PendingIntent>;
}

/** One compiled output to publish. `path` is workspace-relative. */
export interface PublishTarget {
  path: string;
  absolutePath: string;
  content: string;
  documentId: string;
}

function hashBytes(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function block(code: string, message: string, entity?: string): Diagnostic {
  return { severity: "block", code, message, entity };
}

function emptyState(): PublicationState {
  return { version: STATE_VERSION, files: {}, pending: {} };
}

function readState(statePath: string): PublicationState {
  if (!existsSync(statePath)) return emptyState();
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as PublicationState;
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`unsupported publication state version: ${parsed.version}`);
  }
  return { version: parsed.version, files: parsed.files ?? {}, pending: parsed.pending ?? {} };
}

function durableWrite(path: string, content: string): void {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Persist publication state through a same-directory temporary file then rename. */
function writeState(statePath: string, state: PublicationState): void {
  const temp = `${statePath}${TEMP_SUFFIX}`;
  durableWrite(temp, JSON.stringify(state, null, 2));
  renameSync(temp, statePath);
}

/** Hash of the file at `path`, or null when it is absent. */
function diskHash(path: string): string | null {
  if (!existsSync(path)) return null;
  return hashBytes(readFileSync(path, "utf8"));
}

/** Write a new output; never replaces a file that appeared after inspection. */
function atomicCreate(path: string, content: string): void {
  const temp = `${path}${TEMP_SUFFIX}`;
  durableWrite(temp, content);
  try {
    linkSync(temp, path);
  } finally {
    unlinkSync(temp);
  }
}

function atomicReplace(path: string, content: string): void {
  const temp = `${path}${TEMP_SUFFIX}`;
  durableWrite(temp, content);
  renameSync(temp, path);
}

const activePublishers = new Set<string>();

/**
 * Publish compiled outputs under `workspaceRoot`. Callers pass the workspace
 * root and the compiled files. The result never throws for a domain failure.
 */
export function publishCompiled(
  workspaceRoot: string,
  targets: PublishTarget[],
  options: PublishOptions = {},
): { outcomes: PublishOutcome[]; diagnostics: Diagnostic[] } {
  const stateDir = join(workspaceRoot, ".pi", "workspace-docs");
  const statePath = join(stateDir, STATE_FILE);
  if (activePublishers.has(statePath)) {
    return {
      outcomes: [],
      diagnostics: [block("publication-busy", `another publication is already running for ${stateDir}`)],
    };
  }
  activePublishers.add(statePath);
  try {
    return runPublication(workspaceRoot, statePath, targets, options);
  } finally {
    activePublishers.delete(statePath);
  }
}

function runPublication(
  workspaceRoot: string,
  statePath: string,
  targets: PublishTarget[],
  options: PublishOptions,
): { outcomes: PublishOutcome[]; diagnostics: Diagnostic[] } {
  const outcomes: PublishOutcome[] = [];
  const diagnostics: Diagnostic[] = [];

  let state: PublicationState;
  try {
    state = readState(statePath);
  } catch (error) {
    return {
      outcomes,
      diagnostics: [block("publication-state", `cannot read publication state: ${(error as Error).message}`)],
    };
  }

  const blocked = new Set<string>();
  const resolved = new Set<string>();
  const targetByPath = new Map(targets.map((target) => [target.path, target]));

  // Explicit reconciliation runs first (D-17). It mutates durable state and
  // removes any pending intent it resolves, so recovery sees the result.
  for (const entry of options.reconcile ?? []) {
    const result = reconcileOne(state, statePath, workspaceRoot, entry, targetByPath, options, diagnostics);
    outcomes.push(result.outcome);
    if (result.resolved) resolved.add(entry.path);
    if (result.blocked) blocked.add(entry.path);
  }

  recoverPending(state, statePath, workspaceRoot, blocked, outcomes, diagnostics);

  for (const target of targets) {
    if (blocked.has(target.path) || resolved.has(target.path)) continue;
    const result = publishOne(state, statePath, target, options, diagnostics);
    outcomes.push(result);
  }

  return { outcomes, diagnostics };
}

/**
 * Settle durable intent left by an interrupted replacement (D-9).
 *
 * - disk equals the intended output: the replacement happened, so finalize the
 *   record and let the normal pass skip it.
 * - disk equals the previous state: the replacement did not take effect, so drop
 *   the intent and let the normal pass retry it.
 * - anything else: the path changed during the interruption; block it and keep
 *   the intent for an explicit reconciliation.
 */
function recoverPending(
  state: PublicationState,
  statePath: string,
  workspaceRoot: string,
  blocked: Set<string>,
  outcomes: PublishOutcome[],
  diagnostics: Diagnostic[],
): void {
  for (const [path, intent] of Object.entries({ ...state.pending })) {
    let disk: string | null;
    try {
      disk = diskHash(join(workspaceRoot, path));
    } catch (error) {
      blocked.add(path);
      outcomes.push({ path, action: "failed", code: "publication-failed" });
      diagnostics.push(block("publication-failed", `cannot inspect ${path}: ${(error as Error).message}`, path));
      continue;
    }
    if (disk === intent.intendedHash) {
      state.files[path] = { hash: intent.intendedHash, documentId: intent.documentId };
      delete state.pending[path];
      continue;
    }
    if (disk === intent.previousHash) {
      delete state.pending[path];
      continue;
    }
    blocked.add(path);
    outcomes.push({ path, action: "blocked", code: "recovery" });
    diagnostics.push(
      block("recovery", `unfinished publication of ${path} cannot be recovered automatically`, path),
    );
  }
  try {
    writeState(statePath, state);
  } catch (error) {
    diagnostics.push(block("publication-state", `cannot record recovery: ${(error as Error).message}`));
  }
}

function publishOne(
  state: PublicationState,
  statePath: string,
  target: PublishTarget,
  options: PublishOptions,
  diagnostics: Diagnostic[],
  force = false,
): PublishOutcome {
  const intended = hashBytes(target.content);
  const record = state.files[target.path];

  let disk: string | null;
  try {
    disk = diskHash(target.absolutePath);
  } catch (error) {
    diagnostics.push(block("publication-failed", `cannot inspect ${target.path}: ${(error as Error).message}`, target.path));
    return { path: target.path, action: "failed", code: "publication-failed" };
  }

  if (!force) {
    if (record && disk === null) {
      diagnostics.push(block("external-edit", `published output is missing: ${target.path}`, target.path));
      return { path: target.path, action: "blocked", code: "external-edit" };
    }
    if (record && disk !== record.hash) {
      diagnostics.push(
        block("external-edit", `published output changed since it was generated: ${target.path}`, target.path),
      );
      return { path: target.path, action: "blocked", code: "external-edit" };
    }
    if (record && intended === record.hash) {
      return { path: target.path, action: "skipped" };
    }
    if (!record && disk !== null && disk === intended) {
      state.files[target.path] = { hash: intended, documentId: target.documentId };
      if (!persistState(statePath, state, diagnostics)) {
        delete state.files[target.path];
        return { path: target.path, action: "failed", code: "publication-failed" };
      }
      return { path: target.path, action: "adopted" };
    }
    if (!record && disk !== null) {
      diagnostics.push(
        block("first-publication-collision", `refusing to replace a file not generated by workspace-docs: ${target.path}`, target.path),
      );
      return { path: target.path, action: "blocked", code: "first-publication-collision" };
    }
  }

  try {
    options.beforeReplace?.(target.path);
  } catch (error) {
    diagnostics.push(block("publication-failed", `could not publish ${target.path}: ${(error as Error).message}`, target.path));
    return { path: target.path, action: "failed", code: "publication-failed" };
  }

  state.pending[target.path] = {
    previousHash: record?.hash ?? null,
    intendedHash: intended,
    documentId: target.documentId,
  };
  if (!persistState(statePath, state, diagnostics)) {
    delete state.pending[target.path];
    return { path: target.path, action: "failed", code: "publication-failed" };
  }

  try {
    mkdirSync(dirname(target.absolutePath), { recursive: true });
    if (force || record) atomicReplace(target.absolutePath, target.content);
    else atomicCreate(target.absolutePath, target.content);
    options.afterReplace?.(target.path);
  } catch (error) {
    // The intent stays on disk so the next publication recovers this path.
    diagnostics.push(
      block("publication-failed", `could not publish ${target.path}: ${(error as Error).message}`, target.path),
    );
    return { path: target.path, action: "failed", code: "publication-failed" };
  }

  state.files[target.path] = { hash: intended, documentId: target.documentId };
  delete state.pending[target.path];
  if (!persistState(statePath, state, diagnostics)) {
    return { path: target.path, action: "failed", code: "publication-failed" };
  }
  return { path: target.path, action: "written" };
}

interface ReconcileResult {
  outcome: PublishOutcome;
  resolved: boolean;
  blocked: boolean;
}

/**
 * Apply one explicit reconciliation entry (D-17). `accept-disk` records the
 * on-disk baseline, clears any pending intent through the same durable state
 * transition, and skips replacement for this invocation. `replace` overwrites
 * a current target with the rendered bytes. A path that is not a current
 * target, a recorded output, or a pending path is rejected.
 */
function reconcileOne(
  state: PublicationState,
  statePath: string,
  workspaceRoot: string,
  entry: ReconcileEntry,
  targetByPath: Map<string, PublishTarget>,
  options: PublishOptions,
  diagnostics: Diagnostic[],
): ReconcileResult {
  const { path, action } = entry;
  const record = state.files[path];
  const pending = state.pending[path];
  const target = targetByPath.get(path);

  if (!record && !pending && !target) {
    diagnostics.push(
      block("reconcile-ineligible", `reconciliation path is not a current output, recorded output, or pending path: ${path}`, path),
    );
    return { outcome: { path, action: "blocked", code: "reconcile-ineligible" }, resolved: false, blocked: true };
  }

  let disk: string | null;
  try {
    disk = diskHash(join(workspaceRoot, path));
  } catch (error) {
    diagnostics.push(block("reconcile-failed", `cannot inspect ${path}: ${(error as Error).message}`, path));
    return { outcome: { path, action: "failed", code: "reconcile-failed" }, resolved: false, blocked: true };
  }

  if (action === "accept-disk") {
    if (disk === null) {
      if (pending && !target) {
        // An obsolete pending path whose file is gone has nothing to accept.
        delete state.pending[path];
        if (!persistState(statePath, state, diagnostics)) {
          return { outcome: { path, action: "failed", code: "publication-failed" }, resolved: false, blocked: true };
        }
        return { outcome: { path, action: "skipped", code: "accept-disk" }, resolved: true, blocked: false };
      }
      diagnostics.push(block("reconcile-missing", `cannot accept disk for a missing file: ${path}; use replace to recreate it`, path));
      return { outcome: { path, action: "blocked", code: "reconcile-missing" }, resolved: false, blocked: true };
    }
    const documentId = record?.documentId ?? pending?.documentId ?? target?.documentId ?? "";
    state.files[path] = { hash: disk, documentId };
    delete state.pending[path];
    if (!persistState(statePath, state, diagnostics)) {
      return { outcome: { path, action: "failed", code: "publication-failed" }, resolved: false, blocked: true };
    }
    return { outcome: { path, action: "skipped", code: "accept-disk" }, resolved: true, blocked: false };
  }

  if (!target) {
    diagnostics.push(block("reconcile-ineligible", `replace requires the path to be a current output: ${path}`, path));
    return { outcome: { path, action: "blocked", code: "reconcile-ineligible" }, resolved: false, blocked: true };
  }

  const outcome = publishOne(state, statePath, target, options, diagnostics, true);
  return {
    outcome: outcome.action === "written" ? { ...outcome, code: "replace" } : outcome,
    resolved: outcome.action === "written",
    blocked: outcome.action !== "written",
  };
}

function persistState(statePath: string, state: PublicationState, diagnostics: Diagnostic[]): boolean {
  try {
    writeState(statePath, state);
    return true;
  } catch (error) {
    diagnostics.push(block("publication-state", `cannot record publication state: ${(error as Error).message}`));
    return false;
  }
}
