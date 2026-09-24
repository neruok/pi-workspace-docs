/**
 * workspace-docs rendering.
 *
 * Compilation renders the canonical body into publication Markdown. Prose and
 * section headings pass through unchanged. Directive blocks are rendered under
 * the D-3 policy: a record becomes an anchored element with its body, a term
 * becomes an anchored definition, and a link becomes a Markdown link to the
 * target's output path relative to the source document. A deletion directive is
 * authoring metadata and is not published.
 */
import { dirname, relative } from "node:path";
import { load } from "js-toml";

export type PathLookup = (documentId: string) => string | undefined;

function renderReference(reference: string, sourcePath: string, pathFor: PathLookup): string {
  if (reference.startsWith("#") || reference.startsWith("term:")) {
    return `[${reference}](${reference})`;
  }
  const [documentId, anchor] = reference.split("#");
  const target = pathFor(documentId);
  if (!target) return `[${reference}](${reference})`;
  const relativePath = relative(dirname(sourcePath), target).replaceAll("\\", "/");
  return anchor ? `[${reference}](${relativePath}#${anchor})` : `[${reference}](${relativePath})`;
}

/** One combined approver mark from a users list, an agents list, and a legacy single name. */
function approverMark(
  meta: Record<string, unknown>,
  usersKey: string,
  agentsKey: string,
  legacyKey: string,
): string {
  const asList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const people = [...asList(meta[usersKey]), ...(typeof meta[legacyKey] === "string" ? [meta[legacyKey] as string] : [])];
  const agents = asList(meta[agentsKey]);
  const parts: string[] = [];
  if (people.length > 0) parts.push(people.join(", "));
  if (agents.length > 0) parts.push(`agent ${agents.join(", ")}`);
  return parts.join("; ") || "unknown";
}

/** Render one canonical body. Deterministic for a fixed body and path map. */
export function renderBody(body: string, sourcePath: string, pathFor: PathLookup): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const fence = lines[index].match(/^(`{3,})\s*(.*?)\s*$/);
    if (!fence) {
      out.push(lines[index]);
      index += 1;
      continue;
    }
    const info = fence[2];
    const closingFence = new RegExp("^`{" + fence[1].length + ",}\\s*$");
    const inner: string[] = [];
    let end = index + 1;
    while (end < lines.length && !closingFence.test(lines[end])) {
      inner.push(lines[end]);
      end += 1;
    }
    if (!info.startsWith("docs-")) {
      // An ordinary fenced block, including a longer fence that contains
      // shorter fences. Emit it verbatim so inner lines are never parsed.
      out.push(...lines.slice(index, end < lines.length ? end + 1 : end));
      index = end < lines.length ? end + 1 : end;
      continue;
    }
    let split = inner.findIndex((line) => line.trim() === "");
    if (split === -1) split = inner.length;
    const head = inner.slice(0, split).join("\n");
    const prose = inner.slice(split + 1).join("\n").trim();
    let meta: Record<string, unknown> = {};
    try {
      meta = load(head) as Record<string, unknown>;
    } catch {
      meta = {};
    }
    const id = typeof meta.id === "string" ? meta.id : "";
    if (info === "docs-record") {
      out.push(`<a id="${id}"></a>`, "");
      const marks: string[] = [];
      if (meta.approval === "approved") marks.push(`approved by ${approverMark(meta, "approved-users", "approved-agents", "approved-by")}`);
      if (meta.authorization === "authorized") marks.push(`authorized by ${approverMark(meta, "authorized-users", "authorized-agents", "authorized-by")}`);
      const suffix = typeof meta.title === "string" ? ` ${meta.title}` : "";
      const mark = marks.length > 0 ? ` [${marks.join("; ")}]` : "";
      out.push(`**${id}**${suffix}${mark}`, "");
      if (prose) out.push(prose, "");
    } else if (info === "docs-term") {
      const local = meta.scope === "local" ? " _(local)_" : "";
      out.push(`<a id="${id}"></a>`, "", `**${typeof meta.name === "string" ? meta.name : id}**${local}`, "");
      if (prose) out.push(prose, "");
    } else if (info === "docs-link") {
      const from = typeof meta.from === "string" ? meta.from : "";
      const to = typeof meta.to === "string" ? meta.to : "";
      const type = typeof meta.type === "string" ? meta.type : "";
      out.push(`- ${from ? `${from} ` : ""}${type}: ${renderReference(to, sourcePath, pathFor)}`, "");
    } else if (info === "docs-evidence") {
      out.push(`- Evidence for ${String(meta.criterion)} at revision ${String(meta.revision)}: ${String(meta.result)}`, "");
    } else if (info !== "docs-delete") {
      out.push(...inner);
    }
    index = end + 1;
  }
  return out.join("\n").trimEnd();
}
