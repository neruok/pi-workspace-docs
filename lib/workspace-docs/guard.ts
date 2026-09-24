/**
 * workspace-docs — the publication guard (D-12, REQ-EDIT-3).
 *
 * A publication output is generated and is never an authoring source. The Pi
 * extension uses these functions to block built-in `write` and `edit` calls
 * that target a generated artifact, and to return checkout and import guidance.
 *
 * The decision is pure and imports no Pi API, so it is checked without Pi in
 * `scripts/check-workspace-docs-extension.mjs`. A writer the guard cannot
 * intercept (shell redirection, another process) is detected by publication
 * instead, per REQ-EDIT-2 and D-9.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const STORE_DIR = ".pi/workspace-docs";
const CHECKOUT_PREFIX = `${STORE_DIR}/checkout/`;

/** The workspace-relative path a target resolves to, or undefined when it escapes. */
function relativeTarget(cwd: string, target: string): string | undefined {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  const rel = relative(cwd, absolute).replaceAll("\\", "/");
  if (rel.length === 0 || rel === ".." || rel.startsWith("../")) return undefined;
  return rel;
}

/** Output paths recorded by the last successful publication, if any. */
export function recordedOutputs(cwd: string): string[] {
  try {
    const state = JSON.parse(readFileSync(join(cwd, STORE_DIR, "publication.json"), "utf8")) as {
      files?: Record<string, unknown>;
    };
    return Object.keys(state.files ?? {});
  } catch {
    return [];
  }
}

/**
 * True when a built-in write or edit must be blocked. A target inside the store
 * directory is generated unless it is a checkout candidate; a target outside it
 * is blocked when publication recorded it as an output.
 */
export function isPublicationOutput(cwd: string, target: string, outputs: Iterable<string>): boolean {
  const rel = relativeTarget(cwd, target);
  if (rel === undefined) return false;
  if (rel === STORE_DIR || rel.startsWith(`${STORE_DIR}/`)) {
    return !rel.startsWith(CHECKOUT_PREFIX);
  }
  for (const output of outputs) {
    if (output === rel) return true;
  }
  return false;
}

/** Checkout and import guidance returned with every blocked attempt (REQ-EDIT-3). */
export function publicationGuidance(target: string): string {
  return `${target} is a generated workspace-docs artifact and cannot be edited directly; author with workspace-docs checkout, then preview and import the candidate`;
}
