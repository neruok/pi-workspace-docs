/**
 * workspace-docs glossary.
 *
 * Term names and aliases compare after normalization: Unicode NFC, trimmed,
 * internal whitespace collapsed, case-insensitive. A compiled document's
 * glossary lists the terms it defines or references, ordered by normalized
 * name with a shared entry before a local entry of the same name.
 */
import type { TermMatch } from "./model.ts";

export function normalizeTermName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function renderGlossary(entries: TermMatch[]): string {
  if (entries.length === 0) return "";
  const sorted = [...entries].sort((left, right) => {
    const leftName = normalizeTermName(left.name);
    const rightName = normalizeTermName(right.name);
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    if (left.scope !== right.scope) return left.scope === "shared" ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const lines = ["## Glossary", ""];
  for (const entry of sorted) {
    const aliases = entry.aliases.length > 0 ? ` (aliases: ${entry.aliases.join(", ")})` : "";
    const scope = entry.scope === "local" ? " _(local)_" : "";
    lines.push(`- **${entry.name}**${aliases}${scope} — ${entry.body.replace(/\s+/g, " ").trim()}`);
  }
  return lines.join("\n");
}
