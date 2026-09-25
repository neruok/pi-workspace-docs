/**
 * workspace-docs — shared types for the pure documentation core.
 *
 * No Pi import and no runtime behavior live here, so the acceptance checks and
 * the future extension share one vocabulary. Grammar reference:
 * docs/workspace-documentation-spec.md, appendix A.
 */

export type DiagnosticSeverity = "block" | "warn";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  /** 1-based source line, when the diagnostic has a location. */
  line?: number;
  column?: number;
  entity?: string;
}

export type RecordType = "decision" | "requirement" | "invariant" | "acceptance-criterion";
export type LinkType = "references" | "depends-on" | "verified-by" | "supersedes";
export type TermScope = "shared" | "local";

export interface DocumentMeta {
  id: string;
  title: string;
  type: string;
  status?: string;
  outputPath?: string;
  revision: number;
}

export interface Section {
  id: string;
  heading: string;
  depth: number;
  body: string;
}

export type ApprovalState = "proposed" | "approved";
export type AuthorizationState = "unauthorized" | "authorized";

export interface RecordEntity {
  id: string;
  type: RecordType;
  status?: string;
  title?: string;
  approval: ApprovalState;
  approvedUsers: string[];
  approvedAgents: string[];
  authorization: AuthorizationState;
  authorizedUsers: string[];
  authorizedAgents: string[];
  body: string;
}

/** An executed check recorded against a criterion revision. */
export interface EvidenceEntity {
  criterion: string;
  revision: number;
  result: "pass" | "fail";
}

export interface TermEntity {
  id: string;
  name: string;
  aliases: string[];
  scope: TermScope;
  body: string;
}

/** A term definition resolved with its scope and owning document. */
export interface TermMatch {
  id: string;
  name: string;
  aliases: string[];
  scope: TermScope;
  documentId: string;
  body: string;
}

export interface LinkEntity {
  from: string;
  to: string;
  type: LinkType;
  body: string;
}

/** A link whose target matches a query, qualified by its owning document. */
export interface IncomingReference {
  from: string;
  to: string;
  type: LinkType;
}

export interface DeletionEntity {
  id: string;
  reason?: string;
}

export interface DiscoveryEntry {
  id: string;
  title: string;
  type: string;
  status?: string;
  outputPath?: string;
  revision: number;
}

export interface DiscoveryOptions {
  query?: string;
  type?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface DiscoveryResult {
  total: number;
  entries: DiscoveryEntry[];
}

/** One `<!-- docs:generated:<name> -->` region found in a candidate body. */
export interface GeneratedRegion {
  name: string;
  content: string;
  /** 1-based line of the opening marker in the candidate text. */
  line: number;
}

/** A parsed authoring candidate (grammar version 1). */
export interface ParsedCandidate {
  grammar: number;
  document: { id: string; title: string; type: string; status?: string; outputPath?: string };
  baseRevision: number;
  baseStoreRevision: number;
  sections: Section[];
  records: RecordEntity[];
  terms: TermEntity[];
  links: LinkEntity[];
  deletions: DeletionEntity[];
  evidence: EvidenceEntity[];
  diagnostics: Diagnostic[];
  /**
   * Canonical body after the front matter, with generated regions removed. It
   * ends with a newline unless it is empty, so a fresh checkout of a stored
   * body round-trips byte-for-byte.
   */
  rawBody: string;
  /** Generated navigation and glossary views found in the candidate body. */
  generated: GeneratedRegion[];
}

export interface Snapshot {
  storeRevision: number;
  documents: DocumentMeta[];
}

export interface DocumentInput {
  id: string;
  title: string;
  type: string;
  status?: string;
  outputPath?: string;
}

export interface Checkout {
  documentId: string;
  text: string;
  baseRevision: number;
  baseStoreRevision: number;
}

export type ImportStatus = "committed" | "unchanged" | "rejected";

export interface PreviewDiff {
  entity: string;
  before: string;
  after: string;
  truncated: boolean;
}

export interface PreviewSummary {
  added: string[];
  modified: string[];
  omitted: string[];
  unresolved: string[];
  diffs: PreviewDiff[];
}

export interface PreviewResult {
  token: string;
  candidateHash: string;
  diagnostics: Diagnostic[];
  summary: PreviewSummary;
}

export interface ImportResult {
  status: ImportStatus;
  storeRevision: number;
  documentRevision?: number;
  diagnostics: Diagnostic[];
}

export interface CompileResult {
  storeRevision: number;
  files: { path: string; content: string }[];
}

/**
 * Compilation options. `outputRoots` binds a document id to a canonical
 * workspace-relative directory, so the document compiles at `<root>/<output-path>`
 * instead of its stored path (D-20, REQ-COMP-7).
 */
export interface CompileOptions {
  outputRoots?: Record<string, string>;
}

export type PublishAction = "written" | "skipped" | "adopted" | "blocked" | "failed";

export interface PublishOutcome {
  /** Workspace-relative output path. */
  path: string;
  action: PublishAction;
  code?: string;
}

export type ReconcileAction = "accept-disk" | "replace";

/** One explicit resolution for a blocked or pending output path (D-17). */
export interface ReconcileEntry {
  /** Workspace-relative output path. */
  path: string;
  action: ReconcileAction;
}

export interface PublishOptions {
  /** Test seam: called with a path before it is written; a throw fails that path. */
  beforeReplace?: (path: string) => void;
  /** Test seam: called with a path after it is replaced but before its record is stored. */
  afterReplace?: (path: string) => void;
  /** Explicit resolutions applied before recovery and ordinary publication (D-17). */
  reconcile?: ReconcileEntry[];
  /** Effective-path binding applied to this publication (D-20, REQ-COMP-7). */
  outputRoots?: Record<string, string>;
}

export interface PublishResult {
  storeRevision: number;
  outcomes: PublishOutcome[];
  diagnostics: Diagnostic[];
}
