/**
 * workspace-docs deterministic JSON export (D-16).
 *
 * The export is a derived view of the committed snapshot. It never becomes
 * canonical and is not importable. `compile()` renders it beside the Markdown
 * from the same rows, so both outputs share one snapshot. Keys are emitted in a
 * fixed order and optional scalar fields are omitted, so a fixed snapshot and
 * implementation produce byte-identical bytes.
 */
import type { LinkEntity, RecordEntity, Section, TermEntity } from "./model.ts";

export const EXPORT_PATH = ".pi/workspace-docs/export.json";
export const EXPORT_SCHEMA_VERSION = 1;

/** One document's complete canonical content for the export. */
export interface ExportDocument {
  id: string;
  title: string;
  type: string;
  status?: string;
  outputPath?: string;
  revision: number;
  sections: Section[];
  records: RecordEntity[];
  terms: TermEntity[];
  links: LinkEntity[];
}

/** Render the canonical JSON export. Deterministic for a fixed snapshot. */
export function renderExport(storeRevision: number, documents: ExportDocument[]): string {
  const payload = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    storeRevision,
    documents: documents.map((document) => ({
      id: document.id,
      title: document.title,
      type: document.type,
      ...(document.status !== undefined ? { status: document.status } : {}),
      ...(document.outputPath !== undefined ? { outputPath: document.outputPath } : {}),
      revision: document.revision,
      sections: document.sections.map((section) => ({
        id: section.id,
        heading: section.heading,
        depth: section.depth,
        body: section.body,
      })),
      records: document.records.map((record) => ({
        id: record.id,
        type: record.type,
        ...(record.status !== undefined ? { status: record.status } : {}),
        ...(record.title !== undefined ? { title: record.title } : {}),
        approval: record.approval,
        approvedUsers: [...record.approvedUsers],
        approvedAgents: [...record.approvedAgents],
        authorization: record.authorization,
        authorizedUsers: [...record.authorizedUsers],
        authorizedAgents: [...record.authorizedAgents],
        body: record.body,
      })),
      terms: document.terms.map((term) => ({
        id: term.id,
        name: term.name,
        aliases: [...term.aliases],
        scope: term.scope,
        body: term.body,
      })),
      links: document.links.map((link) => ({
        from: link.from,
        to: link.to,
        type: link.type,
        body: link.body,
      })),
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
