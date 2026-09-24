/**
 * workspace-docs — pure core for the workspace documentation store.
 *
 * This module imports no Pi API. The Pi extension and the standalone skills are
 * wrappers over it, so every behavior is checked with plain Node in
 * `scripts/check-workspace-docs.mjs`.
 *
 * - `grammar.ts` parses and serializes grammar version 1.
 * - `store.ts` owns the SQLite store, revisions, and compilation.
 *
 * Grammar and decisions: docs/workspace-documentation-spec.md, appendix A.
 */
export * from "./model.ts";
export {
  GRAMMAR_VERSION,
  ID_PATTERN,
  parseCandidate,
  renderCandidate,
  renderFrontMatter,
  serializeCandidate,
} from "./grammar.ts";
export type { CandidateFields } from "./grammar.ts";
export { SCHEMA_VERSION, openWorkspace } from "./store.ts";
export type { Workspace } from "./store.ts";
export {
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
  renderLinkBlock,
  renderRecordBlock,
  renderSectionBlock,
  renderTermBlock,
  scanBody,
} from "./edit.ts";
export type {
  BodyEditResult,
  BodyRange,
  BodyRangeKind,
  LinkDraft,
  Placement,
  RecordDraft,
  RecordUpdate,
  SectionDraft,
  TermDraft,
  TermUpdate,
} from "./edit.ts";
export { EXPORT_PATH, EXPORT_SCHEMA_VERSION, renderExport } from "./export.ts";
export type { ExportDocument } from "./export.ts";
export { DOCUMENT_STATUSES, DOCUMENT_TYPES, countCodePoints } from "./metadata.ts";
export type { DocumentMetadata } from "./metadata.ts";
