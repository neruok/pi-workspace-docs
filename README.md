# pi-workspace-docs

A Pi extension package for a SQLite-backed workspace documentation store. The
store is canonical; Markdown is compiled output. The extension installs a
publication guard and exposes the `docs_*` tools for discovery, reading,
authoring, validation, compilation, and publication.

This repository is the standalone home of the `workspace-docs` package,
extracted from the `new-coder` Pi profile.

## Layout

| Path | Purpose |
| --- | --- |
| `workspace-docs.ts` | Pi extension entry point. Registers the `docs_*` tools and the publication guard. |
| `lib/workspace-docs/` | Pure core. Imports no Pi API, so it runs under plain Node. |
| `scripts/` | Acceptance, tool-boundary, and publication-guard checks. |
| `scripts/fixtures/workspace-docs/` | Import fixtures used by the acceptance checks. |
| `package.json` | Package manifest. `pi.extensions` points at `workspace-docs.ts`. |

The pure core separates grammar (`grammar.ts`), store and revisions
(`store.ts`), structured editing (`edit.ts`), rendering (`render.ts`),
publication (`publish.ts`), export (`export.ts`), metadata (`metadata.ts`),
terms (`terms.ts`), and the publication guard (`guard.ts`).

## Install into a Pi profile

Add the repository path to the profile `settings.json`:

```json
{
  "packages": ["/path/to/pi-workspace-docs"]
}
```

Then install dependencies:

```sh
npm install
```

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
