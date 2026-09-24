/**
 * workspace-docs — structured authoring over the grammar-range model (D-18).
 *
 * The document body is the single serialization. Prose and structured entities
 * occupy disjoint ranges: a fenced `docs-*` block is a directive, an ATX
 * heading line is a heading, and every other line is prose. A structured tool
 * changes bytes only inside the block, section, or anchor range its operation
 * names, and a range it moves or removes is taken verbatim. Nothing here
 * reformats bytes it does not own, and nothing writes front matter or generated
 * regions.
 *
 * This module imports no Pi API, so it is checked with plain Node in
 * `scripts/check-workspace-docs.mjs`.
 */
import { load } from "js-toml";
import type {
  ApprovalState,
  AuthorizationState,
  Diagnostic,
  LinkType,
  ParsedCandidate,
  RecordType,
  TermScope,
} from "./model.ts";
import { parseCandidate, renderFrontMatter, renderGeneratedRegion } from "./grammar.ts";

const FENCE = /^(`{3,})\s*(.*?)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HEADING_SUFFIX = /^(.*?)\s*\{#([A-Za-z][A-Za-z0-9._-]*)\}\s*$/;
const FRONT_MATTER = /^\+\+\+\n[\s\S]*?\n\+\+\+\n/;

export type BodyRangeKind = "directive" | "heading" | "prose";

/** One grammar range of a raw body, addressed by 0-based line indices. */
export interface BodyRange {
  kind: BodyRangeKind;
  /** 0-based inclusive start line. */
  start: number;
  /** 0-based inclusive end line. */
  end: number;
  /** Directive info string, for a directive range. */
  directive?: string;
  /** Record, term, or deletion id carried by a directive range. */
  id?: string;
  /** Link source, for a `docs-link` directive range. */
  from?: string;
  /** Link target, for a `docs-link` directive range. */
  to?: string;
  /** Link type, for a `docs-link` directive range. */
  linkType?: string;
  /** Section id, for a heading range. */
  sectionId?: string;
  /** Heading depth (number of `#`), for a heading range. */
  depth?: number;
}

/** The fields of a `docs-record` block. */
export interface RecordDraft {
  id: string;
  type: RecordType;
  status?: string;
  title?: string;
  approval?: ApprovalState;
  approvedUsers?: string[];
  approvedAgents?: string[];
  authorization?: AuthorizationState;
  authorizedUsers?: string[];
  authorizedAgents?: string[];
  body?: string;
}

/** Fields a record update may replace; an omitted field is preserved. */
export interface RecordUpdate {
  type?: RecordType;
  status?: string;
  title?: string;
  body?: string;
}

/** The fields of a `docs-term` block. */
export interface TermDraft {
  id: string;
  name: string;
  aliases?: string[];
  scope?: TermScope;
  body?: string;
}

/** Fields a term update may replace; an omitted field is preserved. */
export interface TermUpdate {
  name?: string;
  aliases?: string[];
  scope?: TermScope;
  body?: string;
}

/** The fields of a `docs-link` block. */
export interface LinkDraft {
  from: string;
  to: string;
  type: LinkType;
  body?: string;
}

/** The fields of a new section. */
export interface SectionDraft {
  id: string;
  heading: string;
  depth: number;
  body?: string;
}

/** Placement for an inserted block (D-18). */
export interface Placement {
  /** Place immediately after the directive block carrying this id. */
  after?: string;
  /** Place at the end of the section carrying this id. */
  section?: string;
}

export type BodyEditResult =
  | { status: "ok"; body: string }
  | { status: "not-found"; message: string }
  | { status: "rejected"; diagnostics: Diagnostic[] };

type LineKind =
  | { kind: "fence"; fence: string; info: string }
  | { kind: "heading"; depth: number; text: string }
  | { kind: "prose" };

function classify(line: string): LineKind {
  const fence = line.match(FENCE);
  if (fence) return { kind: "fence", fence: fence[1], info: fence[2] };
  const heading = line.match(HEADING);
  if (heading) return { kind: "heading", depth: heading[1].length, text: heading[2] };
  return { kind: "prose" };
}

/** The TOML fields a directive block carries, when they parse. */
interface DirectiveHead {
  id?: string;
  from?: string;
  to?: string;
  type?: string;
}

function directiveHead(inner: string[]): DirectiveHead {
  let split = inner.findIndex((line) => line.trim() === "");
  if (split === -1) split = inner.length;
  try {
    const meta = load(inner.slice(0, split).join("\n")) as Record<string, unknown>;
    return {
      id: typeof meta.id === "string" ? meta.id : undefined,
      from: typeof meta.from === "string" ? meta.from : undefined,
      to: typeof meta.to === "string" ? meta.to : undefined,
      type: typeof meta.type === "string" ? meta.type : undefined,
    };
  } catch {
    return {};
  }
}

/** Classify a raw body into its ordered grammar ranges (D-18). */
export function scanBody(body: string): BodyRange[] {
  const lines = body.split("\n");
  const ranges: BodyRange[] = [];
  let index = 0;
  while (index < lines.length) {
    const kind = classify(lines[index]);
    if (kind.kind === "fence") {
      const closing = new RegExp("^`{" + kind.fence.length + ",}\\s*$");
      let end = index + 1;
      while (end < lines.length && !closing.test(lines[end])) end += 1;
      if (end < lines.length) {
        const range: BodyRange = { kind: "directive", start: index, end, directive: kind.info };
        if (kind.info.startsWith("docs-")) {
          const head = directiveHead(lines.slice(index + 1, end));
          if (head.id !== undefined) range.id = head.id;
          if (head.from !== undefined) range.from = head.from;
          if (head.to !== undefined) range.to = head.to;
          if (head.type !== undefined) range.linkType = head.type;
        }
        ranges.push(range);
        index = end + 1;
        continue;
      }
    }
    if (kind.kind === "heading") {
      const suffix = kind.text.match(HEADING_SUFFIX);
      ranges.push({
        kind: "heading",
        start: index,
        end: index,
        sectionId: suffix ? suffix[2] : undefined,
        depth: kind.depth,
      });
      index += 1;
      continue;
    }
    let end = index;
    while (end + 1 < lines.length && classify(lines[end + 1]).kind === "prose") end += 1;
    ranges.push({ kind: "prose", start: index, end });
    index = end + 1;
  }
  return ranges;
}

/** Insert a block at a line index, keeping one blank separator on each side. */
function spliceBlock(body: string, at: number, block: string[]): string {
  const lines = body.split("\n");
  const before = at > 0 ? lines[at - 1] : undefined;
  const after = at < lines.length ? lines[at] : undefined;
  const insert: string[] = [];
  if (before !== undefined && before.trim() !== "") insert.push("");
  insert.push(...block);
  if (after !== undefined && after.trim() !== "") insert.push("");
  lines.splice(at, 0, ...insert);
  return lines.join("\n");
}

/** Render one `docs-record` block from a draft. */
export function renderRecordBlock(draft: RecordDraft): string[] {
  const lines = ["```docs-record", `id = ${JSON.stringify(draft.id)}`, `type = ${JSON.stringify(draft.type)}`];
  if (draft.status !== undefined) lines.push(`status = ${JSON.stringify(draft.status)}`);
  if (draft.title !== undefined) lines.push(`title = ${JSON.stringify(draft.title)}`);
  if (draft.approval === "approved") {
    lines.push('approval = "approved"');
    if (draft.approvedUsers !== undefined && draft.approvedUsers.length > 0) {
      lines.push(`approved-users = ${JSON.stringify(draft.approvedUsers)}`);
    }
    if (draft.approvedAgents !== undefined && draft.approvedAgents.length > 0) {
      lines.push(`approved-agents = ${JSON.stringify(draft.approvedAgents)}`);
    }
  }
  if (draft.authorization === "authorized") {
    lines.push('authorization = "authorized"');
    if (draft.authorizedUsers !== undefined && draft.authorizedUsers.length > 0) {
      lines.push(`authorized-users = ${JSON.stringify(draft.authorizedUsers)}`);
    }
    if (draft.authorizedAgents !== undefined && draft.authorizedAgents.length > 0) {
      lines.push(`authorized-agents = ${JSON.stringify(draft.authorizedAgents)}`);
    }
  }
  const prose = (draft.body ?? "").replace(/\s+$/, "");
  if (prose !== "") lines.push("", ...prose.split("\n"));
  lines.push("```");
  return lines;
}

/** Render one `docs-term` block from a draft. */
export function renderTermBlock(draft: TermDraft): string[] {
  const lines = ["```docs-term", `id = ${JSON.stringify(draft.id)}`, `name = ${JSON.stringify(draft.name)}`];
  if (draft.aliases !== undefined && draft.aliases.length > 0) lines.push(`aliases = ${JSON.stringify(draft.aliases)}`);
  if (draft.scope !== undefined && draft.scope !== "shared") lines.push(`scope = ${JSON.stringify(draft.scope)}`);
  const prose = (draft.body ?? "").replace(/\s+$/, "");
  if (prose !== "") lines.push("", ...prose.split("\n"));
  lines.push("```");
  return lines;
}

/** Render one `docs-link` block from a draft. */
export function renderLinkBlock(draft: LinkDraft): string[] {
  const lines = [
    "```docs-link",
    `from = ${JSON.stringify(draft.from)}`,
    `to = ${JSON.stringify(draft.to)}`,
    `type = ${JSON.stringify(draft.type)}`,
  ];
  const prose = (draft.body ?? "").replace(/\s+$/, "");
  if (prose !== "") lines.push("", ...prose.split("\n"));
  lines.push("```");
  return lines;
}

/** Render one section heading plus optional prose. */
export function renderSectionBlock(draft: SectionDraft): string[] {
  const lines = [`${"#".repeat(draft.depth)} ${draft.heading} {#${draft.id}}`];
  const prose = (draft.body ?? "").replace(/\s+$/, "");
  if (prose !== "") lines.push("", ...prose.split("\n"));
  return lines;
}

/** Parse a raw body in a throwaway candidate, so a range edit can read entities. */
function parseBody(body: string): ParsedCandidate {
  return parseCandidate(
    renderFrontMatter({ id: "probe", title: "probe", type: "specification", revision: 0, storeRevision: 0 }) + body,
  );
}

/** Replace a range's lines with a block, leaving every other byte unchanged. */
function replaceRange(body: string, range: BodyRange, block: string[]): string {
  const lines = body.split("\n");
  lines.splice(range.start, range.end - range.start + 1, ...block);
  return lines.join("\n");
}

/** Validate a rendered directive block by parsing it in a throwaway candidate. */
function blockDiagnostics(block: string[]): Diagnostic[] {
  return parseBody(`${block.join("\n")}\n`).diagnostics;
}

/** Resolve where an insertion goes: after a block, at a section end, or at body end (D-18, REQ-TOOL-9). */
function resolveInsertLine(body: string, placement: Placement): { line: number } | { missing: string } {
  const lines = body.split("\n");
  const ranges = scanBody(body);
  if (placement.after !== undefined) {
    const target = ranges.find((range) => range.kind === "directive" && range.id === placement.after);
    if (!target) return { missing: placement.after };
    return { line: target.end + 1 };
  }
  if (placement.section !== undefined) {
    const heading = ranges.find((range) => range.kind === "heading" && range.sectionId === placement.section);
    if (!heading) return { missing: placement.section };
    const next = ranges.find(
      (range) => range.kind === "heading" && range.start > heading.start && (range.depth ?? 0) <= (heading.depth ?? 0),
    );
    return { line: next ? next.start : lines.length - 1 };
  }
  return { line: lines.length - 1 };
}

/**
 * Validate a rendered directive block and insert it at the resolved anchor
 * (D-18, REQ-TOOL-9). Placement is context-dependent: `after` inserts after the
 * named block, `section` inserts before the next heading of equal or shallower
 * depth, and neither inserts at the end of the body. An unresolved anchor
 * returns `not-found` and no body.
 */
function insertBlock(body: string, block: string[], placement: Placement): BodyEditResult {
  const diagnostics = blockDiagnostics(block);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "block")) {
    return { status: "rejected", diagnostics };
  }
  const resolved = resolveInsertLine(body, placement);
  if ("missing" in resolved) return { status: "not-found", message: `no anchor with id ${resolved.missing}` };
  return { status: "ok", body: spliceBlock(body, resolved.line, block) };
}

/** Add one record block to a body (D-18, REQ-TOOL-5). */
export function applyRecordAdd(body: string, draft: RecordDraft, placement: Placement = {}): BodyEditResult {
  return insertBlock(body, renderRecordBlock(draft), placement);
}

/** Add one term block to a body (D-18, REQ-TOOL-7). */
export function applyTermAdd(body: string, draft: TermDraft, placement: Placement = {}): BodyEditResult {
  return insertBlock(body, renderTermBlock(draft), placement);
}

/** Add one link block to a body (D-18, REQ-TOOL-7). */
export function applyLinkAdd(body: string, draft: LinkDraft, placement: Placement = {}): BodyEditResult {
  return insertBlock(body, renderLinkBlock(draft), placement);
}

/**
 * Replace one record's fields in a body (D-18, REQ-TOOL-7). An omitted field is
 * preserved. Only the target block range changes; its position and every byte
 * outside the range are unchanged.
 */
export function applyRecordUpdate(body: string, id: string, update: RecordUpdate): BodyEditResult {
  const ranges = scanBody(body);
  const target = ranges.find(
    (range) => range.kind === "directive" && range.directive === "docs-record" && range.id === id,
  );
  if (!target) return { status: "not-found", message: `no record with id ${id}` };
  const record = parseBody(body).records.find((entry) => entry.id === id);
  if (!record) return { status: "not-found", message: `no record with id ${id}` };
  const merged: RecordDraft = {
    id: record.id,
    type: update.type ?? record.type,
    status: update.status ?? record.status,
    title: update.title ?? record.title,
    approval: record.approval,
    approvedUsers: record.approvedUsers,
    approvedAgents: record.approvedAgents,
    authorization: record.authorization,
    authorizedUsers: record.authorizedUsers,
    authorizedAgents: record.authorizedAgents,
    body: update.body ?? record.body,
  };
  const block = renderRecordBlock(merged);
  const diagnostics = blockDiagnostics(block);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "block")) {
    return { status: "rejected", diagnostics };
  }
  return { status: "ok", body: replaceRange(body, target, block) };
}

/**
 * Replace a directive block with an explicit `docs-delete` at the same position
 * (D-18, REQ-TOOL-7, REQ-MD-5). A deletion with an incoming reference still
 * blocks at import.
 */
function deleteDirective(body: string, id: string, directive: string, label: string, reason?: string): BodyEditResult {
  const ranges = scanBody(body);
  const target = ranges.find(
    (range) => range.kind === "directive" && range.directive === directive && range.id === id,
  );
  if (!target) return { status: "not-found", message: `no ${label} with id ${id}` };
  const block = ["```docs-delete", `id = ${JSON.stringify(id)}`];
  if (reason !== undefined) block.push(`reason = ${JSON.stringify(reason)}`);
  block.push("```");
  return { status: "ok", body: replaceRange(body, target, block) };
}

/** Delete one record by replacing its block with `docs-delete` (D-18, REQ-TOOL-7). */
export function applyRecordDelete(body: string, id: string, reason?: string): BodyEditResult {
  return deleteDirective(body, id, "docs-record", "record", reason);
}

/** Delete one term by replacing its block with `docs-delete` (D-18, REQ-TOOL-7). */
export function applyTermDelete(body: string, id: string, reason?: string): BodyEditResult {
  return deleteDirective(body, id, "docs-term", "term", reason);
}

/**
 * Replace one term's fields in a body (D-18, REQ-TOOL-7). An omitted field is
 * preserved; only the target block range changes.
 */
export function applyTermUpdate(body: string, id: string, update: TermUpdate): BodyEditResult {
  const ranges = scanBody(body);
  const target = ranges.find(
    (range) => range.kind === "directive" && range.directive === "docs-term" && range.id === id,
  );
  if (!target) return { status: "not-found", message: `no term with id ${id}` };
  const term = parseBody(body).terms.find((entry) => entry.id === id);
  if (!term) return { status: "not-found", message: `no term with id ${id}` };
  const block = renderTermBlock({
    id: term.id,
    name: update.name ?? term.name,
    aliases: update.aliases ?? term.aliases,
    scope: update.scope ?? term.scope,
    body: update.body ?? term.body,
  });
  const diagnostics = blockDiagnostics(block);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "block")) {
    return { status: "rejected", diagnostics };
  }
  return { status: "ok", body: replaceRange(body, target, block) };
}

/**
 * Remove the link block matching `from`, `to`, and `type` (D-18, REQ-TOOL-7).
 * Links carry no identity, so removal uses no `docs-delete` directive and its
 * absence is not an omission.
 */
export function applyLinkRemove(body: string, from: string, to: string, type: LinkType): BodyEditResult {
  const ranges = scanBody(body);
  const target = ranges.find(
    (range) =>
      range.kind === "directive" &&
      range.directive === "docs-link" &&
      range.from === from &&
      range.to === to &&
      range.linkType === type,
  );
  if (!target) return { status: "not-found", message: `no link ${from} -> ${to} (${type})` };
  const lines = body.split("\n");
  lines.splice(target.start, target.end - target.start + 1);
  return { status: "ok", body: lines.join("\n") };
}

/** Add one section to a body (D-18, REQ-TOOL-8). */
export function applySectionAdd(body: string, draft: SectionDraft, placement: Placement = {}): BodyEditResult {
  if (!Number.isInteger(draft.depth) || draft.depth < 1 || draft.depth > 6) {
    return {
      status: "rejected",
      diagnostics: [{ severity: "block", code: "section-depth", message: "section depth must be 1 to 6" }],
    };
  }
  return insertBlock(body, renderSectionBlock(draft), placement);
}

/**
 * Move one section range verbatim to the resolved anchor (D-18, REQ-TOOL-8).
 * The range runs from the heading to the last non-blank line before the next
 * heading of equal or shallower depth, so nested headings and directive blocks
 * move with it unchanged.
 */
export function applySectionMove(body: string, id: string, placement: Placement = {}): BodyEditResult {
  const lines = body.split("\n");
  const ranges = scanBody(body);
  const heading = ranges.find((range) => range.kind === "heading" && range.sectionId === id);
  if (!heading) return { status: "not-found", message: `no section with id ${id}` };
  const next = ranges.find(
    (range) => range.kind === "heading" && range.start > heading.start && (range.depth ?? 0) <= (heading.depth ?? 0),
  );
  let end = next ? next.start - 1 : lines.length - 1;
  while (end > heading.start && lines[end].trim() === "") end -= 1;
  const section = lines.slice(heading.start, end + 1);
  const without = [...lines.slice(0, heading.start), ...lines.slice(end + 1)].join("\n");
  const resolved = resolveInsertLine(without, placement);
  if ("missing" in resolved) return { status: "not-found", message: `no anchor with id ${resolved.missing}` };
  return { status: "ok", body: spliceBlock(without, resolved.line, section) };
}

/**
 * Replace a section's immediate prose, preserving its heading, nested headings,
 * and directive blocks byte-for-byte (D-18, REQ-TOOL-8). The immediate prose
 * ends at the first nested heading or directive block, or at the next heading
 * of equal or shallower depth when there is none.
 */
export function applySectionSetBody(body: string, id: string, text: string): BodyEditResult {
  const lines = body.split("\n");
  const ranges = scanBody(body);
  const heading = ranges.find((range) => range.kind === "heading" && range.sectionId === id);
  if (!heading) return { status: "not-found", message: `no section with id ${id}` };
  const next = ranges.find(
    (range) => range.kind === "heading" && range.start > heading.start && (range.depth ?? 0) <= (heading.depth ?? 0),
  );
  const sectionEnd = next ? next.start - 1 : lines.length - 1;
  const boundary = ranges.find(
    (range) =>
      range.start > heading.start &&
      range.start <= sectionEnd &&
      (range.kind === "heading" || range.kind === "directive"),
  );
  const contentEnd = boundary ? boundary.start - 1 : sectionEnd;
  const prose = text.replace(/\s+$/, "");
  const replacement = prose === "" ? ["", ""] : ["", ...prose.split("\n"), ""];
  const out = [...lines.slice(0, heading.start + 1), ...replacement, ...lines.slice(contentEnd + 1)];
  return { status: "ok", body: out.join("\n") };
}

/** Insert caller prose verbatim at the resolved anchor (D-18, REQ-TOOL-8). */
export function applyProseInsert(body: string, text: string, placement: Placement = {}): BodyEditResult {
  const prose = text.replace(/\s+$/, "");
  return insertBlock(body, prose === "" ? [] : prose.split("\n"), placement);
}

/**
 * Replace a candidate's raw body, preserving front matter bytes and the
 * generated regions verbatim (D-18, REQ-TOOL-6). The generated views are
 * re-emitted from their parsed content in the checkout layout: contents before
 * the body, glossary after it.
 */
export function candidateWithBody(text: string, body: string): string {
  const frontMatter = text.match(FRONT_MATTER);
  if (!frontMatter) throw new Error("candidate has no front matter block");
  const parsed = parseCandidate(text);
  const canonical = body === "" ? "" : body.endsWith("\n") ? body : `${body}\n`;
  const toc = parsed.generated.find((region) => region.name === "toc");
  const glossary = parsed.generated.find((region) => region.name === "glossary");
  let out = frontMatter[0];
  if (toc) out += renderGeneratedRegion("toc", toc.content);
  out += canonical;
  if (glossary) {
    if (!out.endsWith("\n")) out += "\n";
    out += renderGeneratedRegion("glossary", glossary.content);
  }
  return out;
}
