/**
 * workspace-docs — Pi extension.
 *
 * Wraps the pure core in `lib/workspace-docs/` (D-14). It installs the
 * publication guard, so a built-in `write` or `edit` that targets a generated
 * artifact is blocked with checkout and import guidance (D-12, REQ-EDIT-3),
 * and it exposes the `docs_*` tools over the store.
 *
 * Tools return one of two shapes:
 *
 * - `{ ok: false, error: { kind } }` — the operation itself was invalid or
 *   unavailable, so no domain result exists. Domain kinds are
 *   `invalid-argument`, `not-found`, `checkout-conflict`, and `rejected`;
 *   `unavailable` covers an unreadable store and file I/O, and `internal`
 *   covers anything unexpected.
 * - `{ ok: true, status: ... }` — the operation ran and produced a domain
 *   result. A `rejected` status (for example, a candidate changed after its
 *   preview) is a valid transaction outcome, not a tool failure.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  applyLinkAdd,
  applyLinkRemove,
  applyProseInsert,
  applyRecordAdd,
  applyRecordDelete,
  applyRecordUpdate,
  applySectionAdd,
  applySectionMove,
  applySectionSetBody,
  applyTermAdd,
  applyTermDelete,
  applyTermUpdate,
  candidateWithBody,
  openWorkspace,
  parseCandidate,
} from "./lib/workspace-docs/index.ts";
import type {
  Diagnostic,
  LinkType,
  Placement,
  RecordType,
  RecordUpdate,
  SectionDraft,
  TermScope,
  TermUpdate,
  Workspace,
} from "./lib/workspace-docs/index.ts";
import {
  STORE_DIR,
  isPublicationOutput,
  publicationGuidance,
  recordedOutputs,
} from "./lib/workspace-docs/guard.ts";

const READ_MAX_BYTES_DEFAULT = 32768;
const READ_MAX_BYTES_LIMIT = 262144;
const READ_MAX_ENTITIES = 2000;
const ITEM_LIMIT = 200;
const TEXT_MAX_BYTES = 1048576;

type Envelope = Record<string, unknown>;

function ok(payload: Envelope) {
  const envelope = { ok: true, ...payload };
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], details: envelope };
}

function fail(kind: string, message: string, extra: Envelope = {}) {
  const envelope = { ok: false, error: { kind, message, ...extra } };
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], details: envelope };
}

/** Infrastructure failures stay distinct from domain rejections. */
function failureFrom(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | undefined)?.code;
  if (/^invalid store:/.test(message)) return fail("unavailable", message, { cause: "store" });
  if (typeof code === "string") return fail("unavailable", message, { cause: "io", code });
  return fail("internal", message);
}

function run(fn: () => ReturnType<typeof ok>) {
  try {
    return fn();
  } catch (error) {
    return failureFrom(error);
  }
}

function withWorkspace<T>(cwd: string, fn: (workspace: Workspace) => T): T {
  const workspace = openWorkspace(cwd);
  try {
    return fn(workspace);
  } finally {
    workspace.close();
  }
}

function bounded<T>(items: T[]): { items: T[]; total: number; truncated: boolean } {
  return { items: items.slice(0, ITEM_LIMIT), total: items.length, truncated: items.length > ITEM_LIMIT };
}

function readBudget(maxBytes: number | undefined): number {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes)) return READ_MAX_BYTES_DEFAULT;
  return Math.min(READ_MAX_BYTES_LIMIT, Math.max(0, Math.floor(maxBytes)));
}

type ReadSelector = { kind: "section" | "record" | "term" | "link"; key: string };

/** Parse a `<kind>:<key>` read selector (REQ-TOOL-11). */
function parseReadSelector(value: string): ReadSelector | { error: string } {
  const separator = value.indexOf(":");
  if (separator <= 0) return { error: `selector must be <kind>:<key>: ${value}` };
  const kind = value.slice(0, separator);
  const key = value.slice(separator + 1);
  if (kind !== "section" && kind !== "record" && kind !== "term" && kind !== "link") {
    return { error: `unknown selector kind: ${kind}` };
  }
  if (key.length === 0) return { error: `selector key is empty: ${value}` };
  return { kind, key };
}

const LINK_TYPES = new Set(["references", "depends-on", "verified-by", "supersedes"]);

/**
 * Resolve a link selector. A link has no identity without its type, so the
 * canonical key is `<type>:<from>-><to>`. An endpoint-only `<from>-><to>` is
 * accepted only when it is unambiguous (REQ-TOOL-11).
 */
function resolveLinkSelector(
  links: Array<{ from: string; to: string; type: string }>,
  key: string,
): { links: Array<{ from: string; to: string; type: string }> } | { error: string; types: string[] } {
  const separator = key.indexOf(":");
  const head = separator > 0 ? key.slice(0, separator) : "";
  const typeQualified = LINK_TYPES.has(head);
  const endpoints = typeQualified ? key.slice(separator + 1) : key;
  const type = typeQualified ? head : undefined;
  const matches = links.filter(
    (link) => `${link.from}->${link.to}` === endpoints && (type === undefined || link.type === type),
  );
  if (type === undefined && matches.length > 1) {
    const types = matches.map((link) => link.type);
    return {
      error: `ambiguous link selector ${key}; it matches types ${types.join(", ")}. Qualify the selector as link:<type>:<from>-><to>`,
      types,
    };
  }
  return { links: matches };
}

function textTooLarge(text: string) {
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes > TEXT_MAX_BYTES ? fail("invalid-argument", `text exceeds ${TEXT_MAX_BYTES} bytes`, { bytes }) : undefined;
}

/**
 * Resolve candidate bytes from either inline `text` or a checkout-candidate
 * `path`. Exactly one is required. The path form keeps a large document out of
 * the tool call; the preview token still binds the exact bytes it read.
 */
function resolveCandidateText(
  cwd: string,
  text: unknown,
  candidatePath: unknown,
): { text: string } | { response: ReturnType<typeof fail> } {
  const hasText = text !== undefined;
  const hasPath = candidatePath !== undefined;
  if (hasText === hasPath) {
    return { response: fail("invalid-argument", "provide exactly one of text or path", { text: hasText, path: hasPath }) };
  }
  if (hasText) {
    if (typeof text !== "string") return { response: fail("invalid-argument", "text must be a string") };
    const tooLarge = textTooLarge(text);
    return tooLarge ? { response: tooLarge } : { text };
  }
  if (typeof candidatePath !== "string" || candidatePath.length === 0) {
    return { response: fail("invalid-argument", "path must be a non-empty workspace-relative candidate path", { path: candidatePath }) };
  }
  if (isAbsolute(candidatePath)) {
    return { response: fail("invalid-argument", "path must be workspace-relative", { path: candidatePath }) };
  }
  const base = join(cwd, STORE_DIR, "checkout");
  const absolute = resolve(cwd, candidatePath);
  const within = relative(base, absolute);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    return { response: fail("invalid-argument", `path must be under ${STORE_DIR}/checkout`, { path: candidatePath }) };
  }
  if (!existsSync(absolute)) {
    return { response: fail("not-found", `no candidate at ${candidatePath}`, { path: candidatePath }) };
  }
  return { text: readFileSync(absolute, "utf8") };
}

/** A content-free summary of one compiled file (AC-61, AC-62). */
function fileSummary(file: { path: string; content: string }) {
  return {
    path: file.path,
    bytes: Buffer.byteLength(file.content, "utf8"),
    lines: file.content.length === 0 ? 0 : file.content.split("\n").length,
  };
}

/**
 * Resolve the candidate a structured tool should edit (D-18, REQ-TOOL-10). An
 * existing candidate at the current base revision is edited in place; a stale
 * one is refused unless `overwrite` discards it; otherwise a fresh candidate is
 * materialized from the stored body.
 */
function candidateToEdit(cwd: string, workspace: Workspace, doc: string, overwrite: boolean | undefined) {
  let fresh;
  try {
    fresh = workspace.checkout(doc);
  } catch {
    return { response: fail("not-found", `unknown document: ${doc}`, { doc }) };
  }
  const path = `${STORE_DIR}/checkout/${doc}.md`;
  const absolute = join(cwd, path);
  let text = fresh.text;
  if (existsSync(absolute) && overwrite !== true) {
    const existing = readFileSync(absolute, "utf8");
    const current = parseCandidate(existing);
    const atBase =
      current.document.id === doc &&
      current.baseRevision === fresh.baseRevision &&
      current.baseStoreRevision === fresh.baseStoreRevision;
    if (!atBase) {
      return {
        response: fail(
          "checkout-conflict",
          `${path} holds a stale candidate; import it, remove it, or pass overwrite: true`,
          { path },
        ),
      };
    }
    text = existing;
  }
  return { text, path, absolute };
}

/** Preview and write a structured edit; never commits (D-18, REQ-TOOL-5). */
function writeStructuredCandidate(
  workspace: Workspace,
  candidateText: string,
  body: string,
  path: string,
  absolute: string,
) {
  const next = candidateWithBody(candidateText, body);
  const preview = workspace.previewImport(next);
  const diagnostics = bounded<Diagnostic>(preview.diagnostics);
  if (diagnostics.items.some((diagnostic) => diagnostic.severity === "block")) {
    return fail("rejected", "the edited candidate is not valid", {
      diagnostics: diagnostics.items,
      totalDiagnostics: diagnostics.total,
      summary: preview.summary,
    });
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, next);
  return ok({
    path,
    token: preview.token,
    candidateHash: preview.candidateHash,
    diagnostics: diagnostics.items,
    totalDiagnostics: diagnostics.total,
    summary: preview.summary,
  });
}

export default function workspaceDocs(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return;
    const target = event.input.path;
    if (typeof target !== "string" || target.length === 0) return;
    if (!isPublicationOutput(ctx.cwd, target, recordedOutputs(ctx.cwd))) return;
    return { block: true, reason: publicationGuidance(target) };
  });

  pi.registerTool({
    name: "docs_discover",
    label: "Discover documents",
    description: "List workspace documents with metadata only, filtered and bounded.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Case-insensitive substring of id or title" })),
      type: Type.Optional(Type.String({ description: "Exact document type" })),
      status: Type.Optional(Type.String({ description: "Exact document status" })),
      limit: Type.Optional(Type.Integer({ minimum: 0, description: "Page size, default 50, clamped to 200" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Page offset" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const page = workspace.discover(params);
          return ok({ total: page.total, entries: page.entries, truncated: page.entries.length < page.total });
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_read",
    label: "Read a document",
    description: "Return a document's metadata and identities, with bodies bounded by a byte budget.",
    parameters: Type.Object({
      id: Type.String({ description: "Document identifier" }),
      selector: Type.Optional(
        Type.String({
          description:
            "Optional <kind>:<key> selector: section:<id>, record:<id>, term:<id>, or link:<type>:<from>-><to> (endpoint-only link:<from>-><to> is accepted only when unique)",
        }),
      ),
      maxBytes: Type.Optional(Type.Integer({ minimum: 0, description: "Body byte budget, default 32768, max 262144" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const document = workspace.read().documents.find((entry) => entry.id === params.id);
          if (!document) return fail("not-found", `unknown document: ${params.id}`, { id: params.id });
          const selector = params.selector === undefined ? undefined : parseReadSelector(params.selector);
          if (selector && "error" in selector) {
            return fail("invalid-argument", selector.error, { selector: params.selector });
          }
          const parsed = parseCandidate(workspace.checkout(params.id).text);
          const selectedSections = selector
            ? selector.kind === "section"
              ? parsed.sections.filter((section) => section.id === selector.key)
              : []
            : parsed.sections;
          const selectedRecords = selector
            ? selector.kind === "record"
              ? parsed.records.filter((record) => record.id === selector.key)
              : []
            : parsed.records;
          const selectedTerms = selector
            ? selector.kind === "term"
              ? parsed.terms.filter((term) => term.id === selector.key)
              : []
            : parsed.terms;
          let selectedLinks: typeof parsed.links;
          if (selector?.kind === "link") {
            const resolved = resolveLinkSelector(parsed.links, selector.key);
            if ("error" in resolved) {
              return fail("invalid-argument", resolved.error, { selector: params.selector, types: resolved.types });
            }
            selectedLinks = resolved.links;
          } else {
            selectedLinks = selector ? [] : parsed.links;
          }
          if (
            selector &&
            selectedSections.length + selectedRecords.length + selectedTerms.length + selectedLinks.length === 0
          ) {
            return fail("not-found", `no ${selector.kind} matches ${selector.key}`, {
              id: params.id,
              selector: params.selector,
            });
          }
          const budget = readBudget(params.maxBytes);
          const omitted: string[] = [];
          let used = 0;
          let totalBytes = 0;
          let processed = 0;
          const bodyOf = (key: string, body: string): string | undefined => {
            processed += 1;
            const bytes = Buffer.byteLength(body, "utf8");
            totalBytes += bytes;
            if (processed > READ_MAX_ENTITIES || used + bytes > budget) {
              omitted.push(key);
              return undefined;
            }
            used += bytes;
            return body;
          };
          const sections = selectedSections.map((section) => ({
            id: section.id,
            heading: section.heading,
            depth: section.depth,
            body: bodyOf(`section:${section.id}`, section.body),
          }));
          const records = selectedRecords.map((record) => ({
            id: record.id,
            type: record.type,
            status: record.status,
            title: record.title,
            approval: record.approval,
            authorization: record.authorization,
            body: bodyOf(`record:${record.id}`, record.body),
          }));
          const terms = selectedTerms.map((term) => ({
            id: term.id,
            name: term.name,
            aliases: term.aliases,
            scope: term.scope,
            body: bodyOf(`term:${term.id}`, term.body),
          }));
          const links = selectedLinks.map((link) => ({
            from: link.from,
            to: link.to,
            type: link.type,
            body: bodyOf(`link:${link.from}->${link.to}`, link.body),
          }));
          return ok({
            document,
            sections,
            records,
            terms,
            links,
            truncated: omitted.length > 0,
            omitted,
            totalBytes,
            returnedBytes: used,
          });
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_checkout",
    label: "Check out a document",
    description: "Write an authoring candidate under the checkout directory and return its path and base revision.",
    parameters: Type.Object({
      id: Type.String({ description: "Document identifier" }),
      overwrite: Type.Optional(Type.Boolean({ description: "Replace an existing edited candidate" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          let checkout;
          try {
            checkout = workspace.checkout(params.id);
          } catch {
            return fail("not-found", `unknown document: ${params.id}`, { id: params.id });
          }
          const path = `${STORE_DIR}/checkout/${params.id}.md`;
          const absolute = join(ctx.cwd, path);
          if (existsSync(absolute) && params.overwrite !== true) {
            const existing = readFileSync(absolute, "utf8");
            if (existing !== checkout.text) {
              return fail(
                "checkout-conflict",
                `${path} already holds an edited or stale candidate; import it, remove it, or pass overwrite: true`,
                { path },
              );
            }
          }
          mkdirSync(dirname(absolute), { recursive: true });
          writeFileSync(absolute, checkout.text);
          return ok({
            path,
            baseRevision: checkout.baseRevision,
            baseStoreRevision: checkout.baseStoreRevision,
            bytes: Buffer.byteLength(checkout.text, "utf8"),
            lines: checkout.text.length === 0 ? 0 : checkout.text.split("\n").length,
          });
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_preview_import",
    label: "Preview an import",
    description: "Parse a candidate and report its diagnostics and change summary without mutating the store.",
    parameters: Type.Object({
      text: Type.Optional(Type.String({ description: "Authoring candidate text; alternative to path" })),
      path: Type.Optional(
        Type.String({ description: "Workspace-relative checkout candidate path from docs_checkout; alternative to text" }),
      ),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() => {
        const resolved = resolveCandidateText(ctx.cwd, params.text, params.path);
        if ("response" in resolved) return resolved.response;
        return withWorkspace(ctx.cwd, (workspace) => {
          const preview = workspace.previewImport(resolved.text);
          const diagnostics = bounded<Diagnostic>(preview.diagnostics);
          return ok({
            token: preview.token,
            candidateHash: preview.candidateHash,
            diagnostics: diagnostics.items,
            totalDiagnostics: diagnostics.total,
            truncated: diagnostics.truncated,
            summary: preview.summary,
          });
        });
      });
    },
  });

  pi.registerTool({
    name: "docs_import",
    label: "Import a candidate",
    description: "Commit an accepted candidate bound to its preview token.",
    parameters: Type.Object({
      text: Type.Optional(Type.String({ description: "Authoring candidate text; alternative to path" })),
      path: Type.Optional(
        Type.String({ description: "Workspace-relative checkout candidate path from docs_checkout; alternative to text" }),
      ),
      token: Type.String({ description: "Token from docs_preview_import" }),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() => {
        const resolved = resolveCandidateText(ctx.cwd, params.text, params.path);
        if ("response" in resolved) return resolved.response;
        return withWorkspace(ctx.cwd, (workspace) => {
          const result = workspace.importCandidate(resolved.text, params.token);
          const diagnostics = bounded<Diagnostic>(result.diagnostics);
          return ok({
            status: result.status,
            storeRevision: result.storeRevision,
            documentRevision: result.documentRevision,
            diagnostics: diagnostics.items,
            totalDiagnostics: diagnostics.total,
            truncated: diagnostics.truncated,
          });
        });
      });
    },
  });

  pi.registerTool({
    name: "docs_record_add",
    label: "Add a record",
    description: "Add a record block to a candidate and return a preview token; import stays explicit.",
    parameters: Type.Object({
      doc: Type.String({ description: "Document identifier" }),
      id: Type.String({ description: "Record identifier, unique within the document" }),
      type: Type.String({ description: "Record type: decision, requirement, invariant, or acceptance-criterion" }),
      body: Type.Optional(Type.String({ description: "Normative prose for the record" })),
      status: Type.Optional(Type.String({ description: "Optional record status" })),
      title: Type.Optional(Type.String({ description: "Optional record title" })),
      section: Type.Optional(Type.String({ description: "Place at the end of this section id" })),
      after: Type.Optional(Type.String({ description: "Place immediately after this directive id" })),
      overwrite: Type.Optional(Type.Boolean({ description: "Discard a stale candidate and start from the stored body" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const state = candidateToEdit(ctx.cwd, workspace, params.doc, params.overwrite);
          if ("response" in state) return state.response;
          const placement: Placement = {};
          if (params.after !== undefined) placement.after = params.after;
          if (params.section !== undefined) placement.section = params.section;
          const edit = applyRecordAdd(
            parseCandidate(state.text).rawBody,
            {
              id: params.id,
              type: params.type as RecordType,
              status: params.status,
              title: params.title,
              body: params.body,
            },
            placement,
          );
          if (edit.status === "not-found") {
            return fail("not-found", edit.message, { anchor: params.after ?? params.section });
          }
          if (edit.status === "rejected") {
            const invalid = bounded<Diagnostic>(edit.diagnostics);
            return fail("rejected", "the record block is not valid", {
              diagnostics: invalid.items,
              totalDiagnostics: invalid.total,
            });
          }
          return writeStructuredCandidate(workspace, state.text, edit.body, state.path, state.absolute);
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_record_update",
    label: "Update a record",
    description: "Replace record fields in a candidate and return a preview token; import stays explicit.",
    parameters: Type.Object({
      doc: Type.String({ description: "Document identifier" }),
      id: Type.String({ description: "Record identifier" }),
      type: Type.Optional(Type.String({ description: "Replacement record type" })),
      status: Type.Optional(Type.String({ description: "Replacement record status" })),
      title: Type.Optional(Type.String({ description: "Replacement record title" })),
      body: Type.Optional(Type.String({ description: "Replacement normative prose" })),
      overwrite: Type.Optional(Type.Boolean({ description: "Discard a stale candidate and start from the stored body" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const state = candidateToEdit(ctx.cwd, workspace, params.doc, params.overwrite);
          if ("response" in state) return state.response;
          const update: RecordUpdate = {};
          if (params.type !== undefined) update.type = params.type as RecordType;
          if (params.status !== undefined) update.status = params.status;
          if (params.title !== undefined) update.title = params.title;
          if (params.body !== undefined) update.body = params.body;
          const edit = applyRecordUpdate(parseCandidate(state.text).rawBody, params.id, update);
          if (edit.status === "not-found") return fail("not-found", edit.message, { id: params.id });
          if (edit.status === "rejected") {
            const invalid = bounded<Diagnostic>(edit.diagnostics);
            return fail("rejected", "the record block is not valid", {
              diagnostics: invalid.items,
              totalDiagnostics: invalid.total,
            });
          }
          return writeStructuredCandidate(workspace, state.text, edit.body, state.path, state.absolute);
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_record_delete",
    label: "Delete a record",
    description: "Replace a record with an explicit docs-delete directive and return a preview token.",
    parameters: Type.Object({
      doc: Type.String({ description: "Document identifier" }),
      id: Type.String({ description: "Record identifier" }),
      reason: Type.Optional(Type.String({ description: "Optional deletion reason" })),
      overwrite: Type.Optional(Type.Boolean({ description: "Discard a stale candidate and start from the stored body" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const state = candidateToEdit(ctx.cwd, workspace, params.doc, params.overwrite);
          if ("response" in state) return state.response;
          const edit = applyRecordDelete(parseCandidate(state.text).rawBody, params.id, params.reason);
          if (edit.status === "not-found") return fail("not-found", edit.message, { id: params.id });
          if (edit.status === "rejected") {
            const invalid = bounded<Diagnostic>(edit.diagnostics);
            return fail("rejected", "the delete directive is not valid", {
              diagnostics: invalid.items,
              totalDiagnostics: invalid.total,
            });
          }
          return writeStructuredCandidate(workspace, state.text, edit.body, state.path, state.absolute);
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_term_add",
    label: "Add a term",
    description: "Add a term block to a candidate and return a preview token; import stays explicit.",
    parameters: Type.Object({
      doc: Type.String({ description: "Document identifier" }),
      id: Type.String({ description: "Term identifier, unique within the document" }),
      name: Type.String({ description: "Canonical term name" }),
      aliases: Type.Optional(Type.Array(Type.String(), { description: "Optional aliases" })),
      scope: Type.Optional(Type.String({ description: "Term scope: shared or local" })),
      body: Type.Optional(Type.String({ description: "Definition prose" })),
      section: Type.Optional(Type.String({ description: "Place at the end of this section id" })),
      after: Type.Optional(Type.String({ description: "Place immediately after this directive id" })),
      overwrite: Type.Optional(Type.Boolean({ description: "Discard a stale candidate and start from the stored body" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const state = candidateToEdit(ctx.cwd, workspace, params.doc, params.overwrite);
          if ("response" in state) return state.response;
          const placement: Placement = {};
          if (params.after !== undefined) placement.after = params.after;
          if (params.section !== undefined) placement.section = params.section;
          const edit = applyTermAdd(
            parseCandidate(state.text).rawBody,
            {
              id: params.id,
              name: params.name,
              aliases: params.aliases,
              scope: params.scope as TermScope | undefined,
              body: params.body,
            },
            placement,
          );
          if (edit.status === "not-found") {
            return fail("not-found", edit.message, { anchor: params.after ?? params.section });
          }
          if (edit.status === "rejected") {
            const invalid = bounded<Diagnostic>(edit.diagnostics);
            return fail("rejected", "the term block is not valid", {
              diagnostics: invalid.items,
              totalDiagnostics: invalid.total,
            });
          }
          return writeStructuredCandidate(workspace, state.text, edit.body, state.path, state.absolute);
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_term_update",
    label: "Update a term",
    description: "Replace term fields in a candidate and return a preview token; import stays explicit.",
    parameters: Type.Object({
      doc: Type.String({ description: "Document identifier" }),
      id: Type.String({ description: "Term identifier" }),
      name: Type.Optional(Type.String({ description: "Replacement canonical name" })),
      aliases: Type.Optional(Type.Array(Type.String(), { description: "Replacement aliases" })),
      scope: Type.Optional(Type.String({ description: "Replacement scope: shared or local" })),
      body: Type.Optional(Type.String({ description: "Replacement definition prose" })),
      overwrite: Type.Optional(Type.Boolean({ description: "Discard a stale candidate and start from the stored body" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const state = candidateToEdit(ctx.cwd, workspace, params.doc, params.overwrite);
          if ("response" in state) return state.response;
          const update: TermUpdate = {};
          if (params.name !== undefined) update.name = params.name;
          if (params.aliases !== undefined) update.aliases = params.aliases;
          if (params.scope !== undefined) update.scope = params.scope as TermScope;
          if (params.body !== undefined) update.body = params.body;
          const edit = applyTermUpdate(parseCandidate(state.text).rawBody, params.id, update);
          if (edit.status === "not-found") return fail("not-found", edit.message, { id: params.id });
          if (edit.status === "rejected") {
            const invalid = bounded<Diagnostic>(edit.diagnostics);
            return fail("rejected", "the term block is not valid", {
              diagnostics: invalid.items,
              totalDiagnostics: invalid.total,
            });
          }
          return writeStructuredCandidate(workspace, state.text, edit.body, state.path, state.absolute);
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_term_delete",
    label: "Delete a term",
    description: "Replace a term with an explicit docs-delete directive and return a preview token.",
    parameters: Type.Object({
      doc: Type.String({ description: "Document identifier" }),
      id: Type.String({ description: "Term identifier" }),
      reason: Type.Optional(Type.String({ description: "Optional deletion reason" })),
      overwrite: Type.Optional(Type.Boolean({ description: "Discard a stale candidate and start from the stored body" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const state = candidateToEdit(ctx.cwd, workspace, params.doc, params.overwrite);
          if ("response" in state) return state.response;
          const edit = applyTermDelete(parseCandidate(state.text).rawBody, params.id, params.reason);
          if (edit.status === "not-found") return fail("not-found", edit.message, { id: params.id });
          if (edit.status === "rejected") {
            const invalid = bounded<Diagnostic>(edit.diagnostics);
            return fail("rejected", "the delete directive is not valid", {
              diagnostics: invalid.items,
              totalDiagnostics: invalid.total,
            });
          }
          return writeStructuredCandidate(workspace, state.text, edit.body, state.path, state.absolute);
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_link_add",
    label: "Add a link",
    description: "Add a docs-link block to a candidate and return a preview token; import stays explicit.",
    parameters: Type.Object({
      doc: Type.String({ description: "Document identifier" }),
      from: Type.String({ description: "Source reference, such as #REQ-1 or doc#REQ-1" }),
      to: Type.String({ description: "Target reference, such as #REQ-1, doc#REQ-1, doc, or term:id" }),
      type: Type.String({ description: "Link type: references, depends-on, verified-by, or supersedes" }),
      body: Type.Optional(Type.String({ description: "Optional link rationale" })),
      section: Type.Optional(Type.String({ description: "Place at the end of this section id" })),
      after: Type.Optional(Type.String({ description: "Place immediately after this directive id" })),
      overwrite: Type.Optional(Type.Boolean({ description: "Discard a stale candidate and start from the stored body" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const state = candidateToEdit(ctx.cwd, workspace, params.doc, params.overwrite);
          if ("response" in state) return state.response;
          const placement: Placement = {};
          if (params.after !== undefined) placement.after = params.after;
          if (params.section !== undefined) placement.section = params.section;
          const edit = applyLinkAdd(
            parseCandidate(state.text).rawBody,
            { from: params.from, to: params.to, type: params.type as LinkType, body: params.body },
            placement,
          );
          if (edit.status === "not-found") {
            return fail("not-found", edit.message, { anchor: params.after ?? params.section });
          }
          if (edit.status === "rejected") {
            const invalid = bounded<Diagnostic>(edit.diagnostics);
            return fail("rejected", "the link block is not valid", {
              diagnostics: invalid.items,
              totalDiagnostics: invalid.total,
            });
          }
          return writeStructuredCandidate(workspace, state.text, edit.body, state.path, state.absolute);
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_link_remove",
    label: "Remove a link",
    description: "Remove the link block matching from, to, and type and return a preview token.",
    parameters: Type.Object({
      doc: Type.String({ description: "Document identifier" }),
      from: Type.String({ description: "Source reference of the link to remove" }),
      to: Type.String({ description: "Target reference of the link to remove" }),
      type: Type.String({ description: "Link type of the link to remove" }),
      overwrite: Type.Optional(Type.Boolean({ description: "Discard a stale candidate and start from the stored body" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const state = candidateToEdit(ctx.cwd, workspace, params.doc, params.overwrite);
          if ("response" in state) return state.response;
          const edit = applyLinkRemove(
            parseCandidate(state.text).rawBody,
            params.from,
            params.to,
            params.type as LinkType,
          );
          if (edit.status === "not-found") {
            return fail("not-found", edit.message, { from: params.from, to: params.to, type: params.type });
          }
          if (edit.status === "rejected") {
            const invalid = bounded<Diagnostic>(edit.diagnostics);
            return fail("rejected", "the link removal is not valid", {
              diagnostics: invalid.items,
              totalDiagnostics: invalid.total,
            });
          }
          return writeStructuredCandidate(workspace, state.text, edit.body, state.path, state.absolute);
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_section_add",
    label: "Add a section",
    description: "Add a section heading and prose to a candidate and return a preview token.",
    parameters: Type.Object({
      doc: Type.String({ description: "Document identifier" }),
      id: Type.String({ description: "Section id, unique within the document" }),
      heading: Type.String({ description: "Readable heading text" }),
      depth: Type.Integer({ minimum: 1, maximum: 6, description: "Heading depth, 1 to 6" }),
      body: Type.Optional(Type.String({ description: "Section prose" })),
      section: Type.Optional(Type.String({ description: "Place at the end of this section id" })),
      after: Type.Optional(Type.String({ description: "Place immediately after this directive id" })),
      overwrite: Type.Optional(Type.Boolean({ description: "Discard a stale candidate and start from the stored body" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const state = candidateToEdit(ctx.cwd, workspace, params.doc, params.overwrite);
          if ("response" in state) return state.response;
          const placement: Placement = {};
          if (params.after !== undefined) placement.after = params.after;
          if (params.section !== undefined) placement.section = params.section;
          const draft: SectionDraft = {
            id: params.id,
            heading: params.heading,
            depth: params.depth,
            body: params.body,
          };
          const edit = applySectionAdd(parseCandidate(state.text).rawBody, draft, placement);
          if (edit.status === "not-found") {
            return fail("not-found", edit.message, { anchor: params.after ?? params.section });
          }
          if (edit.status === "rejected") {
            const invalid = bounded<Diagnostic>(edit.diagnostics);
            return fail("rejected", "the section is not valid", {
              diagnostics: invalid.items,
              totalDiagnostics: invalid.total,
            });
          }
          return writeStructuredCandidate(workspace, state.text, edit.body, state.path, state.absolute);
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_section_move",
    label: "Move a section",
    description: "Relocate a complete section range verbatim and return a preview token.",
    parameters: Type.Object({
      doc: Type.String({ description: "Document identifier" }),
      id: Type.String({ description: "Section id to move" }),
      section: Type.Optional(Type.String({ description: "Place at the end of this section id" })),
      after: Type.Optional(Type.String({ description: "Place immediately after this directive id" })),
      overwrite: Type.Optional(Type.Boolean({ description: "Discard a stale candidate and start from the stored body" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const state = candidateToEdit(ctx.cwd, workspace, params.doc, params.overwrite);
          if ("response" in state) return state.response;
          const placement: Placement = {};
          if (params.after !== undefined) placement.after = params.after;
          if (params.section !== undefined) placement.section = params.section;
          const edit = applySectionMove(parseCandidate(state.text).rawBody, params.id, placement);
          if (edit.status === "not-found") return fail("not-found", edit.message, { id: params.id });
          if (edit.status === "rejected") {
            const invalid = bounded<Diagnostic>(edit.diagnostics);
            return fail("rejected", "the section move is not valid", {
              diagnostics: invalid.items,
              totalDiagnostics: invalid.total,
            });
          }
          return writeStructuredCandidate(workspace, state.text, edit.body, state.path, state.absolute);
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_section_setBody",
    label: "Replace a section body",
    description: "Replace a section's immediate prose, preserving nested headings and blocks.",
    parameters: Type.Object({
      doc: Type.String({ description: "Document identifier" }),
      id: Type.String({ description: "Section id" }),
      text: Type.String({ description: "Replacement prose, inserted verbatim" }),
      overwrite: Type.Optional(Type.Boolean({ description: "Discard a stale candidate and start from the stored body" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const state = candidateToEdit(ctx.cwd, workspace, params.doc, params.overwrite);
          if ("response" in state) return state.response;
          const edit = applySectionSetBody(parseCandidate(state.text).rawBody, params.id, params.text);
          if (edit.status === "not-found") return fail("not-found", edit.message, { id: params.id });
          if (edit.status === "rejected") {
            const invalid = bounded<Diagnostic>(edit.diagnostics);
            return fail("rejected", "the section body is not valid", {
              diagnostics: invalid.items,
              totalDiagnostics: invalid.total,
            });
          }
          return writeStructuredCandidate(workspace, state.text, edit.body, state.path, state.absolute);
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_prose_insert",
    label: "Insert prose",
    description: "Insert caller prose verbatim at an anchor and return a preview token.",
    parameters: Type.Object({
      doc: Type.String({ description: "Document identifier" }),
      text: Type.String({ description: "Prose to insert verbatim" }),
      section: Type.Optional(Type.String({ description: "Place at the end of this section id" })),
      after: Type.Optional(Type.String({ description: "Place immediately after this directive id" })),
      overwrite: Type.Optional(Type.Boolean({ description: "Discard a stale candidate and start from the stored body" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const state = candidateToEdit(ctx.cwd, workspace, params.doc, params.overwrite);
          if ("response" in state) return state.response;
          const placement: Placement = {};
          if (params.after !== undefined) placement.after = params.after;
          if (params.section !== undefined) placement.section = params.section;
          const edit = applyProseInsert(parseCandidate(state.text).rawBody, params.text, placement);
          if (edit.status === "not-found") {
            return fail("not-found", edit.message, { anchor: params.after ?? params.section });
          }
          if (edit.status === "rejected") {
            const invalid = bounded<Diagnostic>(edit.diagnostics);
            return fail("rejected", "the prose is not valid", {
              diagnostics: invalid.items,
              totalDiagnostics: invalid.total,
            });
          }
          return writeStructuredCandidate(workspace, state.text, edit.body, state.path, state.absolute);
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_create",
    label: "Create a document",
    description: "Create an empty document with an explicit id; no lifecycle value is invented.",
    parameters: Type.Object({
      id: Type.String({ description: "Immutable document identifier" }),
      title: Type.String({ description: "Document title" }),
      type: Type.String({ description: "Document type: specification, design, decision-record, or note" }),
      status: Type.Optional(
        Type.String({ description: "Optional lifecycle status: draft, active, or retired; never defaulted" }),
      ),
      outputPath: Type.Optional(Type.String({ description: "Optional workspace-relative output path" })),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const result = workspace.createDocument({
            id: params.id,
            title: params.title,
            type: params.type,
            status: params.status,
            outputPath: params.outputPath,
          });
          const diagnostics = bounded<Diagnostic>(result.diagnostics);
          return ok({
            status: result.status,
            storeRevision: result.storeRevision,
            documentRevision: result.documentRevision,
            diagnostics: diagnostics.items,
          });
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_validate",
    label: "Validate the workspace",
    description: "Report structural diagnostics, including unresolved references, with a bounded count.",
    parameters: Type.Object({}),
    execute(_id, _params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const diagnostics = bounded<Diagnostic>(workspace.validate());
          return ok({ diagnostics: diagnostics.items, total: diagnostics.total, truncated: diagnostics.truncated });
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_references",
    label: "Inspect references",
    description: "List the entities that reference a target identity, with a bounded count.",
    parameters: Type.Object({ target: Type.String({ description: "Target identity, such as doc#id or term:id" }) }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          if (!workspace.hasTarget(params.target)) {
            return fail("not-found", `unknown target: ${params.target}`, { target: params.target });
          }
          const references = bounded(workspace.incomingReferences(params.target));
          return ok({ references: references.items, total: references.total, truncated: references.truncated });
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_terms",
    label: "Look up terms",
    description: "Resolve a normalized term name or alias to its definitions, with a bounded count.",
    parameters: Type.Object({ query: Type.String({ description: "Term name or alias" }) }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const matches = bounded(workspace.lookupTerm(params.query));
          return ok({ terms: matches.items, total: matches.total, truncated: matches.truncated });
        }),
      );
    },
  });

  pi.registerTool({
    name: "docs_compile",
    label: "Compile the workspace",
    description: "Render the workspace; publish only when publish is true, and never claim partial success.",
    parameters: Type.Object({
      publish: Type.Optional(Type.Boolean({ description: "Write outputs; defaults to false" })),
      outputRoots: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Document id to canonical workspace-relative output root (D-20)",
        }),
      ),
      reconcile: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: "Workspace-relative output path" }),
            action: Type.Union([Type.Literal("accept-disk"), Type.Literal("replace")]),
          }),
          { description: "Explicit resolutions for blocked or pending outputs (D-17)" },
        ),
      ),
    }),
    execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        withWorkspace(ctx.cwd, (workspace) => {
          const rootDiagnostics = workspace.outputRootDiagnostics(params.outputRoots);
          if (rootDiagnostics.some((diagnostic) => diagnostic.severity === "block")) {
            return fail(
              "invalid-argument",
              rootDiagnostics.map((diagnostic) => diagnostic.message).join("; "),
              { diagnostics: rootDiagnostics },
            );
          }
          const compiled = workspace.compile({ outputRoots: params.outputRoots });
          const files = compiled.files.map(fileSummary);
          if (params.publish !== true) {
            return ok({ storeRevision: compiled.storeRevision, files });
          }
          const result = workspace.publish({ outputRoots: params.outputRoots, reconcile: params.reconcile });
          const complete =
            result.diagnostics.every((diagnostic) => diagnostic.severity !== "block") &&
            result.outcomes.every((outcome) => outcome.action !== "blocked" && outcome.action !== "failed");
          return ok({
            storeRevision: result.storeRevision,
            files,
            outcomes: result.outcomes,
            diagnostics: result.diagnostics,
            complete,
          });
        }),
      );
    },
  });
}
