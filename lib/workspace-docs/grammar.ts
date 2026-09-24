/**
 * workspace-docs grammar, version 1.
 *
 * Parses an authoring candidate into its document metadata, sections, records,
 * terms, links, and deletions. The structured syntax is the fenced `docs-*`
 * directive grammar in docs/workspace-documentation-spec.md, appendix A.
 *
 * The parser never calls a model. It reports every determinable diagnostic and
 * marks each one `block` or `warn`. Anything that cannot be preserved becomes a
 * `block` diagnostic instead of being silently discarded.
 */
import { load } from "js-toml";
import type {
  DeletionEntity,
  Diagnostic,
  GeneratedRegion,
  LinkEntity,
  LinkType,
  ParsedCandidate,
  RecordEntity,
  RecordType,
  Section,
  TermEntity,
} from "./model.ts";

export const GRAMMAR_VERSION = 1;

const RECORD_TYPES: RecordType[] = ["decision", "requirement", "invariant", "acceptance-criterion"];
const LINK_TYPES: LinkType[] = ["references", "depends-on", "verified-by", "supersedes"];
const DIRECTIVES = ["docs-record", "docs-term", "docs-link", "docs-delete", "docs-evidence"];
/** Generated views a candidate may carry. Other names are unsupported (REQ-MD-8). */
export const GENERATED_REGION_NAMES = ["toc", "glossary"] as const;
export type GeneratedRegionName = (typeof GENERATED_REGION_NAMES)[number];
const REGION_OPEN = /^<!--\s*docs:generated:([A-Za-z][A-Za-z0-9-]*)\s*-->\s*$/;
const REGION_CLOSE = /^<!--\s*\/docs:generated:([A-Za-z][A-Za-z0-9-]*)\s*-->\s*$/;
/** Document, section, record, and term identifier format. */
export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

const FRONT_MATTER_KEYS = new Set([
  "grammar",
  "authoring",
  "id",
  "title",
  "type",
  "status",
  "output-path",
  "revision",
  "store-revision",
]);

export interface CandidateFields {
  id: string;
  title: string;
  type: string;
  status?: string;
  outputPath?: string;
  revision: number;
  storeRevision: number;
}

/** Render one marked generated region, ending with its closing marker's newline. */
export function renderGeneratedRegion(name: string, content: string): string {
  return `<!-- docs:generated:${name} -->\n${content}\n<!-- /docs:generated:${name} -->\n`;
}

/** A canonical body ends with a newline unless it is empty (REQ-MD-7). */
function canonicalizeBody(body: string): string {
  if (body === "") return "";
  return body.endsWith("\n") ? body : `${body}\n`;
}

/**
 * Remove every `<!-- docs:generated:<name> -->` region from a body and return
 * the remaining canonical lines with the regions that were found. Unknown or
 * malformed regions block rather than being discarded silently (REQ-MD-8).
 */
function extractGeneratedRegions(
  bodyLines: string[],
  bodyStartLine: number,
  diagnostics: Diagnostic[],
): { lines: string[]; generated: GeneratedRegion[] } {
  const lines: string[] = [];
  const generated: GeneratedRegion[] = [];
  let index = 0;
  while (index < bodyLines.length) {
    const lineNumber = bodyStartLine + index;
    const line = bodyLines[index];
    if (REGION_CLOSE.test(line)) {
      push(diagnostics, "generated-region", `unexpected generated region close: ${line.trim()}`, lineNumber);
      index += 1;
      continue;
    }
    const open = line.match(REGION_OPEN);
    if (!open) {
      lines.push(line);
      index += 1;
      continue;
    }
    const name = open[1];
    if (!(GENERATED_REGION_NAMES as readonly string[]).includes(name)) {
      push(diagnostics, "generated-region", `unknown generated region: ${name}`, lineNumber);
    }
    if (generated.some((region) => region.name === name)) {
      push(diagnostics, "generated-region", `duplicate generated region: ${name}`, lineNumber);
    }
    const content: string[] = [];
    let end = index + 1;
    let closed = false;
    while (end < bodyLines.length) {
      const close = bodyLines[end].match(REGION_CLOSE);
      if (close) {
        if (close[1] !== name) {
          push(
            diagnostics,
            "generated-region",
            `generated region ${name} is closed by ${close[1]}`,
            bodyStartLine + end,
          );
        }
        closed = true;
        break;
      }
      content.push(bodyLines[end]);
      end += 1;
    }
    if (!closed) {
      push(diagnostics, "generated-region", `unterminated generated region: ${name}`, lineNumber);
      break;
    }
    generated.push({ name, content: content.join("\n"), line: lineNumber });
    index = end + 1;
  }
  return { lines, generated };
}

/** TOML basic strings share JSON's escapes for the characters identifiers use. */
function quote(value: string): string {
  return JSON.stringify(value);
}

/** Render only the `+++` front matter block, ending with its closing newline. */
export function renderFrontMatter(fields: CandidateFields): string {
  const lines = [
    "+++",
    `grammar = ${GRAMMAR_VERSION}`,
    'authoring = "checkout"',
    `id = ${quote(fields.id)}`,
    `title = ${quote(fields.title)}`,
    `type = ${quote(fields.type)}`,
  ];
  if (fields.status !== undefined) lines.push(`status = ${quote(fields.status)}`);
  if (fields.outputPath !== undefined) lines.push(`output-path = ${quote(fields.outputPath)}`);
  lines.push(`revision = ${fields.revision}`, `store-revision = ${fields.storeRevision}`, "+++");
  return `${lines.join("\n")}\n`;
}

/** Render a full authoring candidate: front matter followed by the body. */
export function renderCandidate(fields: CandidateFields, body: string): string {
  return renderFrontMatter(fields) + body;
}

function push(
  diagnostics: Diagnostic[],
  code: string,
  message: string,
  line?: number,
  entity?: string,
): void {
  diagnostics.push({ severity: "block", code, message, line, entity });
}

/**
 * Normalize one approver list plus an optional legacy single-name key.
 * Entries are trimmed, empty entries dropped, then deduplicated and sorted so
 * the stored list is canonical (D-5). Returns undefined after a block when a
 * value has the wrong shape.
 */
function approverList(
  meta: Record<string, unknown>,
  listKey: string,
  legacyKey: string | undefined,
  diagnostics: Diagnostic[],
  code: string,
  line: number,
  id: string,
): string[] | undefined {
  const entries: string[] = [];
  const raw = meta[listKey];
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
      push(diagnostics, code, `${listKey} must be an array of strings`, line, id);
      return undefined;
    }
    entries.push(...(raw as string[]));
  }
  const legacy = legacyKey ? meta[legacyKey] : undefined;
  if (legacy !== undefined) {
    if (typeof legacy !== "string") {
      push(diagnostics, code, `${legacyKey} must be a string`, line, id);
      return undefined;
    }
    entries.push(legacy);
  }
  const cleaned = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return [...new Set(cleaned)].sort();
}

/** Parse an authoring candidate. Never throws for malformed input. */
export function parseCandidate(text: string): ParsedCandidate {
  const diagnostics: Diagnostic[] = [];
  const candidate: ParsedCandidate = {
    grammar: 0,
    document: { id: "", title: "", type: "" },
    baseRevision: 0,
    baseStoreRevision: 0,
    sections: [],
    records: [],
    terms: [],
    links: [],
    deletions: [],
    evidence: [],
    diagnostics,
    rawBody: text,
    generated: [],
  };

  const lines = text.split("\n");
  const firstLine = lines[0] ?? "";
  if (firstLine.trimEnd() !== "+++") {
    if (firstLine.includes("<!-- generated by workspace-docs.")) {
      push(
        diagnostics,
        "authoring-marker",
        "publication outputs are generated and cannot be imported; author with `workspace-docs checkout` and import the candidate",
        1,
      );
    } else {
      push(diagnostics, "front-matter", "candidate must start with a +++ front matter block", 1);
    }
    return candidate;
  }
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === "+++") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    push(diagnostics, "front-matter", "front matter block is not closed", 1);
    return candidate;
  }

  const bodyStartLine = close + 2;
  const bodyLines = lines.slice(close + 1);
  const { lines: canonicalLines, generated } = extractGeneratedRegions(bodyLines, bodyStartLine, diagnostics);
  candidate.generated = generated;
  const body = canonicalizeBody(canonicalLines.join("\n"));
  candidate.rawBody = body;

  let frontMatter: Record<string, unknown>;
  try {
    frontMatter = load(lines.slice(1, close).join("\n")) as Record<string, unknown>;
  } catch (error) {
    push(diagnostics, "front-matter-parse", `front matter is not valid TOML: ${(error as Error).message.split("\n")[0]}`, 2);
    return candidate;
  }

  for (const key of Object.keys(frontMatter)) {
    if (!FRONT_MATTER_KEYS.has(key)) push(diagnostics, "front-matter-key", `unknown front matter key: ${key}`, 2);
  }
  if (frontMatter.grammar !== GRAMMAR_VERSION) {
    push(diagnostics, "grammar-version", `unsupported grammar version: ${String(frontMatter.grammar)}`, 2);
  } else {
    candidate.grammar = GRAMMAR_VERSION;
  }
  if (frontMatter.authoring !== "checkout") {
    push(diagnostics, "authoring-marker", 'front matter must set authoring = "checkout"; author with `workspace-docs checkout`', 2);
  }
  const id = frontMatter.id;
  // The id pattern and bound are validated by the store with grandfathering
  // (D-2), so an existing non-conforming id can be preserved unchanged.
  if (typeof id !== "string" || id.length === 0) {
    push(diagnostics, "document-id", "front matter must set a document id", 2);
  }
  if (typeof frontMatter.title !== "string") push(diagnostics, "front-matter", "front matter must set title", 2);
  if (typeof frontMatter.type !== "string") push(diagnostics, "front-matter", "front matter must set type", 2);
  if (!Number.isInteger(frontMatter.revision) || (frontMatter.revision as number) < 0) {
    push(diagnostics, "front-matter", "front matter must set an integer revision", 2);
  }
  if (!Number.isInteger(frontMatter["store-revision"]) || (frontMatter["store-revision"] as number) < 0) {
    push(diagnostics, "front-matter", "front matter must set an integer store-revision", 2);
  }
  if (frontMatter.status !== undefined && typeof frontMatter.status !== "string") {
    push(diagnostics, "front-matter", "status must be a string", 2);
  }
  if (frontMatter["output-path"] !== undefined && typeof frontMatter["output-path"] !== "string") {
    push(diagnostics, "front-matter", "output-path must be a string", 2);
  }

  if (typeof id === "string") {
    candidate.document = {
      id,
      title: typeof frontMatter.title === "string" ? frontMatter.title : "",
      type: typeof frontMatter.type === "string" ? frontMatter.type : "",
      status: typeof frontMatter.status === "string" ? frontMatter.status : undefined,
      outputPath: typeof frontMatter["output-path"] === "string" ? frontMatter["output-path"] : undefined,
    };
  }
  if (Number.isInteger(frontMatter.revision)) candidate.baseRevision = frontMatter.revision as number;
  if (Number.isInteger(frontMatter["store-revision"])) candidate.baseStoreRevision = frontMatter["store-revision"] as number;

  parseBody(candidate, body.split("\n"), bodyStartLine);
  return candidate;
}

function parseBody(
  candidate: ParsedCandidate,
  bodyLines: string[],
  bodyStartLine: number,
): void {
  const diagnostics = candidate.diagnostics;
  const sectionIds = new Set<string>();
  const recordIds = new Set<string>();
  const termIds = new Set<string>();
  let current: Section | null = null;
  let prose: string[] = [];

  const flush = (): void => {
    if (current) current.body = prose.join("\n").replace(/\s+$/, "");
    prose = [];
  };

  let index = 0;
  while (index < bodyLines.length) {
    const line = bodyLines[index];
    const fence = line.match(/^(`{3,})\s*(.*?)\s*$/);
    if (fence) {
      const fenceLine = bodyStartLine + index;
      const info = fence[2];
      const closingFence = new RegExp("^`{" + fence[1].length + ",}\\s*$");
      const inner: string[] = [];
      let end = index + 1;
      while (end < bodyLines.length && !closingFence.test(bodyLines[end])) {
        inner.push(bodyLines[end]);
        end += 1;
      }
      if (end >= bodyLines.length) {
        push(diagnostics, "fence", "unterminated fenced block", fenceLine);
        break;
      }
      if (info.startsWith("docs-")) {
        parseDirective(candidate, info, inner, fenceLine + 1, recordIds, termIds);
      } else {
        prose.push(...bodyLines.slice(index, end + 1));
      }
      index = end + 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const lineNumber = bodyStartLine + index;
      const suffix = heading[2].match(/^(.*?)\s*\{#([A-Za-z][A-Za-z0-9._-]*)\}\s*$/);
      if (!suffix) {
        push(diagnostics, "section-id", "heading must end with a stable {#section-id}", lineNumber);
      } else {
        const sectionId = suffix[2];
        if (sectionIds.has(sectionId)) {
          push(diagnostics, "section-id", `duplicate section id: ${sectionId}`, lineNumber);
        }
        sectionIds.add(sectionId);
        flush();
        current = { id: sectionId, heading: suffix[1].trim(), depth: heading[1].length, body: "" };
        candidate.sections.push(current);
      }
      index += 1;
      continue;
    }

    prose.push(line);
    index += 1;
  }
  flush();
}

function parseDirective(
  candidate: ParsedCandidate,
  info: string,
  inner: string[],
  startLine: number,
  recordIds: Set<string>,
  termIds: Set<string>,
): void {
  const diagnostics = candidate.diagnostics;
  if (!DIRECTIVES.includes(info)) {
    push(diagnostics, "directive", `unrecognized directive: ${info}`, startLine - 1);
    return;
  }
  let split = inner.findIndex((line) => line.trim() === "");
  if (split === -1) split = inner.length;
  const head = inner.slice(0, split).join("\n");
  const body = inner.slice(split + 1).join("\n").replace(/\s+$/, "");

  let meta: Record<string, unknown>;
  try {
    meta = load(head) as Record<string, unknown>;
  } catch (error) {
    push(diagnostics, "directive-parse", `${info} metadata is not valid TOML: ${(error as Error).message.split("\n")[0]}`, startLine);
    return;
  }

  if (info === "docs-record") {
    const id = meta.id;
    const type = meta.type;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      push(diagnostics, "record-id", "docs-record requires a valid id", startLine);
      return;
    }
    if (typeof type !== "string" || !RECORD_TYPES.includes(type as RecordType)) {
      push(diagnostics, "record-type", `docs-record has an unknown type: ${String(type)}`, startLine, id);
      return;
    }
    if (recordIds.has(id)) {
      push(diagnostics, "record-id", `duplicate record id: ${id}`, startLine, id);
      return;
    }
    recordIds.add(id);
    const approval = meta.approval === undefined ? "proposed" : meta.approval;
    const authorization = meta.authorization === undefined ? "unauthorized" : meta.authorization;
    if (approval !== "proposed" && approval !== "approved") {
      push(diagnostics, "record-approval", `approval must be proposed or approved: ${String(approval)}`, startLine, id);
      return;
    }
    if (authorization !== "unauthorized" && authorization !== "authorized") {
      push(diagnostics, "record-authorization", `authorization must be unauthorized or authorized: ${String(authorization)}`, startLine, id);
      return;
    }
    const record: RecordEntity = {
      id,
      type: type as RecordType,
      approval,
      approvedUsers: [],
      approvedAgents: [],
      authorization,
      authorizedUsers: [],
      authorizedAgents: [],
      body,
    };
    if (typeof meta.status === "string") record.status = meta.status;
    if (typeof meta.title === "string") record.title = meta.title;
    if (approval === "approved") {
      const users = approverList(meta, "approved-users", "approved-by", diagnostics, "record-approval", startLine, id);
      const agents = approverList(meta, "approved-agents", undefined, diagnostics, "record-approval", startLine, id);
      if (users === undefined || agents === undefined) return;
      record.approvedUsers = users;
      record.approvedAgents = agents;
    }
    if (authorization === "authorized") {
      const users = approverList(meta, "authorized-users", "authorized-by", diagnostics, "record-authorization", startLine, id);
      const agents = approverList(meta, "authorized-agents", undefined, diagnostics, "record-authorization", startLine, id);
      if (users === undefined || agents === undefined) return;
      record.authorizedUsers = users;
      record.authorizedAgents = agents;
    }
    candidate.records.push(record);
    return;
  }

  if (info === "docs-term") {
    const id = meta.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      push(diagnostics, "term-id", "docs-term requires a valid id", startLine);
      return;
    }
    if (typeof meta.name !== "string") {
      push(diagnostics, "term-name", "docs-term requires a name", startLine, id);
      return;
    }
    if (meta.scope !== undefined && meta.scope !== "shared" && meta.scope !== "local") {
      push(diagnostics, "term-scope", 'docs-term scope must be "shared" or "local"', startLine, id);
      return;
    }
    if (termIds.has(id)) {
      push(diagnostics, "term-id", `duplicate term id: ${id}`, startLine, id);
      return;
    }
    if (meta.aliases !== undefined && (!Array.isArray(meta.aliases) || meta.aliases.some((alias) => typeof alias !== "string"))) {
      push(diagnostics, "term-alias", "docs-term aliases must be an array of strings", startLine, id);
      return;
    }
    termIds.add(id);
    candidate.terms.push({
      id,
      name: meta.name,
      aliases: Array.isArray(meta.aliases) ? (meta.aliases as string[]) : [],
      scope: meta.scope === "local" ? "local" : "shared",
      body,
    });
    return;
  }

  if (info === "docs-link") {
    const from = meta.from;
    const to = meta.to;
    const type = meta.type;
    const valid = typeof from === "string" && typeof to === "string" && typeof type === "string" && LINK_TYPES.includes(type as LinkType);
    if (!valid) {
      push(diagnostics, "link", "docs-link requires from, to, and a known type", startLine);
      return;
    }
    candidate.links.push({ from: from as string, to: to as string, type: type as LinkType, body });
    return;
  }

  if (info === "docs-evidence") {
    const criterion = meta.criterion;
    const revision = meta.revision;
    const result = meta.result;
    if (
      typeof criterion !== "string" ||
      !ID_PATTERN.test(criterion) ||
      !Number.isInteger(revision) ||
      (result !== "pass" && result !== "fail")
    ) {
      push(diagnostics, "evidence", "docs-evidence requires a criterion, an integer revision, and result pass or fail", startLine);
      return;
    }
    candidate.evidence.push({ criterion, revision: revision as number, result: result as "pass" | "fail" });
    return;
  }

  const id = meta.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    push(diagnostics, "delete-id", "docs-delete requires a valid id", startLine);
    return;
  }
  const deletion: DeletionEntity = { id };
  if (typeof meta.reason === "string") deletion.reason = meta.reason;
  candidate.deletions.push(deletion);
}

/** Serialize a parsed candidate back to grammar version 1. */
export function serializeCandidate(candidate: ParsedCandidate): string {
  return renderCandidate(
    {
      id: candidate.document.id,
      title: candidate.document.title,
      type: candidate.document.type,
      status: candidate.document.status,
      outputPath: candidate.document.outputPath,
      revision: candidate.baseRevision,
      storeRevision: candidate.baseStoreRevision,
    },
    candidate.rawBody,
  );
}
