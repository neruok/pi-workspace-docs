---
name: workspace-docs-authoring
description: Author and change documents in the workspace documentation store through the extension tools. Use when creating or editing a design, specification, decision, requirement, term, or link in the store, or when resolving an import conflict. Do not use for reviewing content someone else authored.
---

# Author workspace documentation

Author through the extension. The store under `.pi/workspace-docs/` is canonical. A Markdown candidate is the only import path into it.

This skill covers the store workflow. Requirement semantics and prose style are
separate concerns: if the workspace provides the `write-deterministic-specifications`
or `ste-writing` skills, use them for those. They are not part of this package
and may be absent.

## Workflow

1. `docs_discover` to find the document and `docs_read` to inspect it. Pass `selector: "<kind>:<key>"` (`section:<id>`, `record:<id>`, `term:<id>`, or `link:<type>:<from>-><to>`) to read one entity instead of the whole document. A link needs its type; an endpoint-only `link:<from>-><to>` works only when one link matches.
2. If the document does not exist, use `docs_create`. It invents no lifecycle value.
3. Use the structured tools below, or use `docs_checkout` and edit its candidate with ordinary file tools. Checkout writes `.pi/workspace-docs/checkout/<id>.md` with the document identity and base revisions. It returns the candidate path, not the document text. Use `read` to inspect that file.
4. `docs_preview_import` parses the candidate without mutating the store. Pass exactly one of `path` (the checkout candidate) or `text` (a small inline edit). Read `diagnostics` and `summary` before you continue. `summary.diffs` carries the stored and candidate content for each modified entity, bounded to 2048 bytes per side and 200 entries; a `truncated` flag marks a cut side.
5. `docs_import` with the same `path` or `text` and the token from the exact preview you accepted. A candidate edited after its preview is rejected with `candidate-changed`.
6. `docs_validate`, `docs_references`, and `docs_terms` to check structure, references, and terms.
7. `docs_compile` to render. Publication is off unless you pass `publish: true`. The result lists each file as `path`, `bytes`, and `lines`, not its rendered body; read the published file or use `docs_read` for content.

Do not hand-edit front matter `revision` or `store-revision`. They bind the candidate to a base revision.

## Structured authoring tools

Twelve tools edit a document's structured entities without a whole-document round-trip. Each successful write edits the candidate and returns its path, preview token, diagnostics, and change summary. If no candidate exists, the tool creates one from the stored document. None commits.

Inspect `diagnostics` and `summary` after each successful write. Consecutive writes accumulate on one candidate. Import the final candidate with the path and token from the last successful write. A later manual edit requires a new `docs_preview_import` before import.

- `docs_record_add`, `docs_record_update`, `docs_record_delete`
- `docs_term_add`, `docs_term_update`, `docs_term_delete`
- `docs_link_add`, `docs_link_remove`
- `docs_section_add`, `docs_section_move`, `docs_section_setBody`
- `docs_prose_insert`

Ownership is by grammar range. The body owns existence, order, and prose; a record or term owns its fields and its directive block. A tool changes bytes only inside the block, section, or anchor range it names, and it moves or removes those bytes verbatim. It never reformats front matter or generated regions.

Placement is context-dependent. `after: <id>` places content immediately after that block. `section: <id>` places it at the end of that section, before the next heading of equal or shallower depth. With neither, it goes at the end of the body, before the generated glossary.

Deletion stays explicit. `docs_record_delete` and `docs_term_delete` replace the block with a `docs-delete` directive carrying its id. Removing a block without that directive blocks as `omission`. `docs_link_remove` matches `from`, `to`, and `type` and uses no directive. Follow the deletion order below before removing a referenced entity.

`docs_section_setBody` replaces only the section's immediate prose and preserves nested headings and directive blocks.

An existing candidate at the current base revision is edited in place, so consecutive structured edits and unsaved manual edits accumulate. A stale candidate returns `checkout-conflict`; pass `overwrite: true` only to discard it deliberately. Use the candidate file with ordinary file tools for anything the structured tools do not cover.

## Candidate rules

- Structured content uses fenced `docs-record`, `docs-term`, `docs-link`, and `docs-delete` blocks with TOML metadata. Ordinary prose never creates an entity.
- A heading needs a stable suffix: `## Scope {#scope}`.
- `<!-- docs:generated:toc -->` and `<!-- docs:generated:glossary -->` are generated views. Do not edit inside them. A missing region is allowed. Take a fresh checkout to regenerate them.
- A publication output is generated and is not importable. Author through checkout, never by editing an output.

## Document metadata

`docs_create` and the front matter take these D-2 values:

- `type`: required, one of `specification`, `design`, `decision-record`, `note`.
- `status`: optional, one of `draft`, `active`, `retired`. Omit it to leave the status unset; an empty or whitespace-only status is invalid.
- `title`: required, trimmed, 1-200 code points.
- `output-path`: optional, workspace-relative, at most 512 code points.
- `id`: immutable, at most 128 code points. A changed id targets a different document; it is not a rename.

A changed field is normalized and validated. An unchanged stored value is grandfathered and may warn without blocking.

## Records and links

- Record `type`: `decision`, `requirement`, `invariant`, `acceptance-criterion`.
- Link `type`: `references`, `depends-on`, `verified-by`, `supersedes`.
- Link a requirement to its acceptance criterion with `verified-by`.
- Record and term identifiers are unique within the document and match `^[A-Za-z][A-Za-z0-9._-]*$`.

## Normative content and rationale

Keep normative requirements (`MUST`, `MUST NOT`, `SHOULD`, `MAY`) separate from rationale and examples. An example does not create a requirement unless the text declares it normative.

## Unresolved decisions

Do not invent policy. When a material choice is unresolved, keep it visible instead of choosing a default.

- Record an open choice as a proposed decision record and state the open question in its body.
- Do not invent lifecycle, type, approval, or authorization values. Use the D-2 values above; stop and ask when a required value is unknown.
- Compilation and structural validation do not approve anything.

## Deletion and approval data

- Delete only with an explicit `docs-delete` directive and explicit authorization. Never remove an identified entity by omitting it.
- `approval` and `authorization` are explicit state fields. A prose claim, a `status` field, or polished output does not establish approval.
- Approver names are attributed data, not authenticated. Record who approved with `approved-users`, `approved-agents`, `authorized-users`, or `authorized-agents`. Lists are stored sorted and deduplicated, and a missing approver is allowed. The legacy `approved-by` key maps to a single `approved-users` entry.

### Deletion order

Follow these steps only with explicit authorization for the deletion and its reference changes.

1. Query `docs_references` for the target identity before deletion. Inspect the candidate for links that are not yet in the store.
2. Remove or repoint incoming links in other documents, then import those changes first. An uncommitted candidate in another document does not remove a stored reference.
3. Refresh the target candidate after those imports. Preserve and reapply its intended edits as described under conflict recovery.
4. Remove or repoint same-document links in the target candidate before calling `docs_record_delete` or `docs_term_delete`. Use `docs_link_remove` for removal. To repoint a link, remove the old link and add its replacement.
5. Inspect the deletion preview, then explicitly import the final candidate.

A structured deletion with remaining references returns `rejected` with a `referenced` diagnostic. It does not write the attempted deletion to the candidate. Resolve the references before retrying. Do not assume the failed call left a deletion ready to import.

## Conflict recovery

Inspect the error and the candidate before choosing a recovery action. Never force an import or change its base revision fields.

- `candidate-changed`: If the base revisions still match, keep the edited candidate and run `docs_preview_import` again. Inspect the new preview and import with its token. Do not take a fresh checkout merely to replace a stale token. If either base revision differs, follow the `revision` procedure.
- `revision`: Preserve the edited candidate before replacing it. Read the current stored document and compare the intended changes. Take a fresh checkout only after preserving those edits and confirming replacement is authorized. Reapply only the intended changes, then preview and import again.
- `checkout-conflict`: Read the existing candidate first. If its document and store base revisions match, continue editing it or preview it directly. Otherwise, follow the `revision` procedure. A normal checkout can conflict with an edited candidate even when its base revisions still match.

Use `overwrite: true` only when replacement is authorized. It discards the existing candidate, including uncommitted edits. If ownership or the intended resolution is unclear, stop and ask. Stop and ask if overlapping external edits appear.

After an import, the candidate can have stale base revisions. Refresh it before starting another edit. An import that changes another document advances the store revision and can make this candidate stale.

## Boundaries

- Do not create a second store. The extension owns the store.
- Do not edit the store file directly.
- Do not treat a clean structural validation as proof that the content is correct.
