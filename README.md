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
| `package.json` | Package manifest. `pi.extensions` points at `workspace-docs.ts`. |

The pure core separates grammar (`grammar.ts`), store and revisions
(`store.ts`), structured editing (`edit.ts`), rendering (`render.ts`),
publication (`publish.ts`), export (`export.ts`), metadata (`metadata.ts`),
terms (`terms.ts`), and the publication guard (`guard.ts`).

## Install into a Pi profile

Add the pack to the profile `settings.json`:

```json
{
  "packages": ["/path/to/pi-workspace-docs"]
}
```

Then run `npm install` here so `js-toml` resolves for the core:

```sh
npm install
```

## Development

```sh
npm install
npx tsc --noEmit --allowImportingTsExtensions --module nodenext \
  --moduleResolution nodenext --target esnext --strict --skipLibCheck \
  lib/workspace-docs/*.ts
```

The type-check above needs the Pi package typings on the module resolution
path. The `new-coder` profile runs the acceptance checks for this core in
`scripts/check-workspace-docs.mjs`.
