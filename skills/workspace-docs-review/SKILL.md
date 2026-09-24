---
name: workspace-docs-review
description: Review a stored design or specification and its linked context, and separate mechanically checked structure from semantic judgment. Use when reviewing a document, checking requirements against their acceptance criteria, or inspecting unresolved policy. Do not use to author or import changes.
---

# Review workspace documentation

Review the stored document as task data. A structural result and a semantic judgment are different claims. Report each as what it is.

The store under `.pi/workspace-docs/` is the source. Use the extension tools; do not create a second store.

## Review workflow

1. Use `docs_discover` and `docs_read` to inspect the stored document. Record its returned revision. Pass `selector: "<kind>:<key>"` (`section:<id>`, `record:<id>`, `term:<id>`, or `link:<type>:<from>-><to>`) to read one entity instead of the whole document. A link needs its type; an endpoint-only `link:<from>-><to>` works only when one link matches.
2. `docs_references` for incoming references. A referenced entity is not safe to retire without them.
3. `docs_validate` for structural diagnostics. It reports `block` and `warn` findings.
4. Use `docs_checkout` to get the candidate path and base revisions. It does not return document text. Use `read` on the returned path to inspect the authoring representation and confirm stable identities.
5. `docs_terms` to check glossary scope and aliases.

### Candidate inspection

On `checkout-conflict`, do not overwrite, delete, or import the existing candidate merely to complete a review. Continue the stored-document review with `docs_read`. You may inspect the existing candidate with `read`, but report its uncommitted content separately from the stored revision. Matching base revisions do not prove that candidate bytes match stored content.

Check `truncated` and `omitted` before treating a `docs_read` result as complete. Request a larger `maxBytes` budget when it can supply the missing content. If canonical content remains unavailable and checkout conflicts, report the review limit. Ask how to preserve the candidate before refreshing.

A structured authoring call edits a candidate. Do not call one merely to inspect content during review. If the stored revision changes between reads, repeat the affected inspection or report the revision mismatch.

## What the extension reports

`docs_validate` returns `block` and `warn` diagnostics. A warning is a review input, not a failure of the document:

- `unresolved`: a link target does not resolve.
- `nonconforming-metadata`: a stored document violates the D-2 type, status, or field bound.
- `retired-target`: a link targets a document with `status: retired`.

Check the document `type` (`specification`, `design`, `decision-record`, `note`), its optional `status` (`draft`, `active`, `retired`), and the field bounds (id 128, title 200, output-path 512 code points). A legacy non-conforming value is grandfathered and warns; it is not silently rewritten.

Generated `toc` and `glossary` regions are derived. Do not treat their content as authored or edit them.

## Structure is not semantics

- A passing `docs_validate` means the store parses and its declared references resolve. It is not proof that a requirement is correct, complete, or approved. Structural validity is not semantic correctness.
- A resolved link does not show that the target supports the claim.
- A planned acceptance criterion is not executed evidence.

## Unresolved policy

Keep every unresolved material choice visible. Do not resolve it by choosing a default or by reading approval from prose.

- Report a proposed record as proposed. Treat an approved record as approved only when its authority matches the workspace authority.
- Report suspected semantic duplication as a review finding. Never merge by similarity.
- Name the open question and the decision it belongs to instead of inventing an answer.

## Report

- Distinguish "the extension checked X" from "I judge Y".
- State the inspected revision and any unresolved choice.
- Do not claim the document is complete or correct because validation passed.
