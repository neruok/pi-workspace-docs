# pi-workspace-docs

A Pi extension package for a SQLite-backed workspace documentation store.

Documents are authored in the store, not in Markdown. The store
(`.pi/workspace-docs/store.sqlite`) is canonical, and compilation renders
Markdown output. Every change goes through a checkout → preview → import cycle,
so an edit carries a base revision and an explicit commit. The extension also
installs a publication guard that blocks direct `write` and `edit` calls to
generated artifacts.

This repository is the standalone home of the `workspace-docs` package,
extracted from the `new-coder` Pi profile.

## How it works

1. `docs_create` adds an empty document with an explicit id.
2. `docs_checkout` writes a candidate to `.pi/workspace-docs/checkout/<id>.md`
   and returns its path and base revision.
3. Author the candidate: use the structured `docs_record_*`, `docs_term_*`,
   `docs_link_*`, `docs_section_*`, and `docs_prose_insert` tools (each writes
   the candidate and returns a preview token), or edit the file and call
   `docs_preview_import`.
4. `docs_import` commits a previewed candidate. The preview token binds the
   exact candidate bytes, so a changed file or a moved revision is rejected.
5. `docs_compile` renders the workspace and, with `publish: true`, writes the
   output files. A recorded external edit is reconciled or blocked, never
   silently overwritten.

The candidate grammar is version 1. The store schema is version 1.

## Tools

| Tool | Purpose |
| --- | --- |
| `docs_discover` | List documents with metadata only, filtered and bounded. |
| `docs_read` | Read a document's metadata and identities, with bodies bounded by a byte budget. |
| `docs_checkout` | Write an authoring candidate and return its path and base revision. |
| `docs_preview_import` | Parse a candidate and report diagnostics and a change summary without mutating the store. |
| `docs_import` | Commit an accepted candidate bound to its preview token. |
| `docs_record_add` | Add a record block to a candidate and return a preview token. |
| `docs_record_update` | Replace record fields in a candidate and return a preview token. |
| `docs_record_delete` | Replace a record with an explicit `docs-delete` directive and return a preview token. |
| `docs_term_add` | Add a term block to a candidate and return a preview token. |
| `docs_term_update` | Replace term fields in a candidate and return a preview token. |
| `docs_term_delete` | Replace a term with an explicit `docs-delete` directive and return a preview token. |
| `docs_link_add` | Add a `docs-link` block to a candidate and return a preview token. |
| `docs_link_remove` | Remove the link block matching from, to, and type and return a preview token. |
| `docs_section_add` | Add a section heading and prose to a candidate and return a preview token. |
| `docs_section_move` | Relocate a complete section range verbatim and return a preview token. |
| `docs_section_setBody` | Replace a section's immediate prose, preserving nested headings and blocks. |
| `docs_prose_insert` | Insert caller prose verbatim at an anchor and return a preview token. |
| `docs_create` | Create an empty document with an explicit id. |
| `docs_validate` | Report structural diagnostics, including unresolved references. |
| `docs_references` | List the entities that reference a target identity. |
| `docs_terms` | Resolve a normalized term name or alias to its definitions. |
| `docs_compile` | Render the workspace; publish only when `publish` is true, and never claim partial success. |

Structured tools never commit. `docs_create` adds a document directly;
after that, only `docs_import` with a preview token writes to the store.

## Skills

The package declares two skills under `pi.skills`:

- `workspace-docs-authoring` — the checkout → preview → import workflow,
  structured tool use, deletion order, and conflict recovery.
- `workspace-docs-review` — separating structural validation from semantic
  judgment and keeping unresolved policy visible.

Each is a directory with a `SKILL.md`. Installing the package makes them
available to the profile's skill list.

## Requirements

- The Pi coding agent (`@earendil-works/pi-coding-agent`).
- Node.js 22.18 or newer. The extension is loaded by Pi; the checks run under
  plain Node and use its TypeScript type stripping.

## Install

Users install the package from its Git source. Pi clones it, installs the
`js-toml` dependency, and loads the extension and the two skills.

```sh
pi install git:github.com/neruok/pi-workspace-docs
```

Add `--local` (`-l`) to write the declaration to the project settings instead
of the personal settings. To try it for one invocation without installing:

```sh
pi -e git:github.com/neruok/pi-workspace-docs
```

Pin a ref for a stable install. An unpinned source follows the default branch.

```sh
pi install git:github.com/neruok/pi-workspace-docs@<tag-or-commit>
```

You can also declare it in `settings.json` directly:

```json
{
  "packages": ["git:github.com/neruok/pi-workspace-docs"]
}
```

The package is not published to npm, so `pi install git:...` is the supported
install path. `pi update --extensions` reconciles installed packages.

### Local development

For work on the package itself, install the local directory. Pi loads it in
place without copying:

```sh
pi install ./pi-workspace-docs
```

Then run `npm install` in the package directory so `js-toml` resolves for
`npm run check` and `npm run typecheck`.

## Layout

| Path | Purpose |
| --- | --- |
| `workspace-docs.ts` | Pi extension entry point. Registers the `docs_*` tools and the publication guard. |
| `lib/workspace-docs/` | Pure core. Imports no Pi API, so it runs under plain Node. |
| `scripts/` | Acceptance, tool-boundary, publication-guard, and skill checks. |
| `scripts/fixtures/workspace-docs/` | Import fixtures used by the acceptance checks. |
| `skills/` | The `workspace-docs-authoring` and `workspace-docs-review` skills, declared under `pi.skills`. |
| `package.json` | Package manifest. Declares the extension (`pi.extensions`) and skills (`pi.skills`). |

The pure core separates grammar (`grammar.ts`), the store, revisions, and
compilation (`store.ts`), structured editing (`edit.ts`), rendering
(`render.ts`), publication (`publish.ts`), export (`export.ts`), metadata
(`metadata.ts`), terms (`terms.ts`), and the publication guard (`guard.ts`).

## Development

```sh
npm install
npm run typecheck   # tsc --strict over the pure core
npm run check       # acceptance, tool-boundary, and guard checks
```

The acceptance checks describe criteria from
`docs/workspace-documentation-spec.md` in the `new-coder` profile's
documentation store. The tool-boundary and publication-guard checks copy the
extension and core into a temporary directory and resolve the Pi package from
the global install, so a global `@earendil-works/pi-coding-agent` must be
present.

## License

MIT. See [LICENSE](LICENSE).
