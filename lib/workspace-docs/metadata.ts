/**
 * workspace-docs document metadata contract (D-2).
 *
 * The closed document type and lifecycle sets, the code-point field bounds, the
 * normalization rule, and the grandfathering comparison for documents stored
 * before these rules. One validator serves create and import, so no write path
 * can bypass it. `id` is immutable: it is the document key, not a mutable field.
 *
 * Grammar reference: docs/workspace-documentation-spec.md, appendix A.
 */
import type { Diagnostic } from "./model.ts";

export const DOCUMENT_TYPES = ["specification", "design", "decision-record", "note"] as const;
export const DOCUMENT_STATUSES = ["draft", "active", "retired"] as const;
export const DOCUMENT_MAX_ID = 128;
export const DOCUMENT_MAX_TITLE = 200;
export const DOCUMENT_MAX_OUTPUT_PATH = 512;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

export interface DocumentMetadata {
  id: string;
  title: string;
  type: string;
  status?: string;
  outputPath?: string;
}

/** Count Unicode code points, not UTF-16 units or UTF-8 bytes (D-2). */
export function countCodePoints(value: string): number {
  return [...value].length;
}

function block(code: string, message: string, entity?: string): Diagnostic {
  return { severity: "block", code, message, line: 2, entity };
}

export interface MetadataResolution {
  diagnostics: Diagnostic[];
  /** The values a write stores: normalized, or the stored value when preserved. */
  metadata: DocumentMetadata;
  /** True when the output path is new or differs from the stored value. */
  outputPathChanged: boolean;
}

/**
 * Resolve and validate one document write. `stored` is the existing row for an
 * import and is absent for a create. A field whose raw candidate value equals
 * the stored raw value is grandfathered and preserved exactly; a differing
 * value is trimmed (except `id` and `output-path`) and validated.
 */
export function resolveDocumentMetadata(
  candidate: DocumentMetadata,
  stored?: DocumentMetadata,
): MetadataResolution {
  const diagnostics: Diagnostic[] = [];
  const metadata: DocumentMetadata = { id: candidate.id, title: "", type: "" };

  if (stored === undefined) {
    if (!ID_PATTERN.test(candidate.id)) {
      diagnostics.push(block("document-id", `invalid document id: ${candidate.id}`, candidate.id));
    } else if (countCodePoints(candidate.id) > DOCUMENT_MAX_ID) {
      diagnostics.push(block("document-id", `document id exceeds ${DOCUMENT_MAX_ID} code points`, candidate.id));
    }
    metadata.id = candidate.id;
  } else {
    // id is immutable: the candidate id selects the row, so it is preserved.
    if (candidate.id !== stored.id) {
      diagnostics.push(block("document-id", `document id is immutable; expected ${stored.id}`, candidate.id));
    }
    metadata.id = stored.id;
  }

  if (stored !== undefined && candidate.title === stored.title) {
    metadata.title = stored.title;
  } else {
    const title = candidate.title.trim();
    if (title.length === 0) {
      diagnostics.push(block("document-title", "document title must not be empty", metadata.id));
    } else if (countCodePoints(title) > DOCUMENT_MAX_TITLE) {
      diagnostics.push(block("document-title", `document title exceeds ${DOCUMENT_MAX_TITLE} code points`, metadata.id));
    }
    metadata.title = title;
  }

  if (stored !== undefined && candidate.type === stored.type) {
    metadata.type = stored.type;
  } else {
    const type = candidate.type.trim();
    if (!(DOCUMENT_TYPES as readonly string[]).includes(type)) {
      diagnostics.push(block("document-type", `unknown document type: ${candidate.type}`, metadata.id));
    }
    metadata.type = type;
  }

  if (stored !== undefined && candidate.status === stored.status) {
    metadata.status = stored.status;
  } else if (candidate.status === undefined) {
    metadata.status = undefined;
  } else {
    const status = candidate.status.trim();
    if (status.length === 0) {
      diagnostics.push(block("document-status", "document status must not be empty", metadata.id));
    } else if (!(DOCUMENT_STATUSES as readonly string[]).includes(status)) {
      diagnostics.push(block("document-status", `unknown lifecycle status: ${candidate.status}`, metadata.id));
    }
    metadata.status = status;
  }

  const outputPathChanged = stored === undefined || candidate.outputPath !== stored.outputPath;
  if (!outputPathChanged && stored !== undefined) {
    metadata.outputPath = stored.outputPath;
  } else {
    if (candidate.outputPath !== undefined && countCodePoints(candidate.outputPath) > DOCUMENT_MAX_OUTPUT_PATH) {
      diagnostics.push(
        block("output-path", `output-path exceeds ${DOCUMENT_MAX_OUTPUT_PATH} code points`, metadata.id),
      );
    }
    metadata.outputPath = candidate.outputPath;
  }

  return { diagnostics, metadata, outputPathChanged };
}

/** The D-2 fields a stored document violates, for a non-blocking warning. */
export function metadataViolations(metadata: DocumentMetadata): string[] {
  const violations: string[] = [];
  const id = metadata.id;
  if (!ID_PATTERN.test(id) || countCodePoints(id) > DOCUMENT_MAX_ID) violations.push("id");
  const title = metadata.title.trim();
  if (metadata.title !== title || title.length === 0 || countCodePoints(title) > DOCUMENT_MAX_TITLE) {
    violations.push("title");
  }
  const type = metadata.type.trim();
  if (metadata.type !== type || !(DOCUMENT_TYPES as readonly string[]).includes(type)) violations.push("type");
  if (metadata.status !== undefined) {
    const status = metadata.status.trim();
    if (metadata.status !== status || status.length === 0 || !(DOCUMENT_STATUSES as readonly string[]).includes(status)) {
      violations.push("status");
    }
  }
  if (metadata.outputPath !== undefined && countCodePoints(metadata.outputPath) > DOCUMENT_MAX_OUTPUT_PATH) {
    violations.push("output-path");
  }
  return violations;
}

/** A non-blocking warning for every D-2 violation in one stored document. */
export function nonConformingMetadataDiagnostics(metadata: DocumentMetadata): Diagnostic[] {
  return metadataViolations(metadata).map((field) => ({
    severity: "warn" as const,
    code: "nonconforming-metadata",
    message: `document ${metadata.id} has a non-conforming ${field} value`,
    entity: metadata.id,
  }));
}
