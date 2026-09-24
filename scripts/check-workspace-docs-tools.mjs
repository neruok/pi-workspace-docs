#!/usr/bin/env node
// Boundary checks for the workspace-docs tool surface (D-14).
//
// These checks define the contract for the registered tools: their bounds,
// checkout collision handling, compile defaults, and error variants. See
// docs/workspace-documentation-spec.md, decision D-14, in the new-coder
// profile's documentation store.
//
// The extension and the core are copied into a temporary directory beside a
// node_modules symlink set. Nothing here touches a real workspace.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const repoDir = fileURLToPath(new URL("../", import.meta.url));
const packageDir = resolve(
  process.argv[2] ??
    join(
      execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).trim(),
      "@earendil-works/pi-coding-agent",
    ),
);

const scratch = mkdtempSync(join(tmpdir(), "pi-workspace-docs-tools-"));
const results = [];

async function check(ac, name, fn) {
  try {
    await fn();
    results.push({ ac, name, ok: true, reason: "" });
  } catch (error) {
    results.push({ ac, name, ok: false, reason: error?.message ?? String(error) });
  }
}

/** Replace a document body through the core, keeping the checkout front matter. */
function setBody(ws, id, body) {
  const text = ws.checkout(id).text;
  const front = text.match(/^\+\+\+\n[\s\S]*?\n\+\+\+\n/);
  if (!front) throw new Error("checkout has no front matter");
  const candidate = front[0] + body;
  const preview = ws.previewImport(candidate);
  assert.equal(ws.importCandidate(candidate, preview.token).status, "committed", `seed ${id}`);
}

try {
  const modules = join(scratch, "node_modules");
  mkdirSync(join(modules, "@earendil-works"), { recursive: true });
  symlinkSync(packageDir, join(modules, "@earendil-works", "pi-coding-agent"), "dir");
  symlinkSync(join(packageDir, "node_modules", "typebox"), join(modules, "typebox"), "dir");
  for (const entry of readdirSync(join(repoDir, "node_modules"))) {
    if (entry === "@earendil-works") continue;
    symlinkSync(join(repoDir, "node_modules", entry), join(modules, entry), "dir");
  }
  mkdirSync(join(scratch, "lib", "workspace-docs"), { recursive: true });
  for (const file of readdirSync(join(repoDir, "lib", "workspace-docs"))) {
    copyFileSync(
      join(repoDir, "lib", "workspace-docs", file),
      join(scratch, "lib", "workspace-docs", file),
    );
  }
  const extensionPath = join(scratch, "workspace-docs.ts");
  copyFileSync(join(repoDir, "workspace-docs.ts"), extensionPath);

  const core = await import(pathToFileURL(join(scratch, "lib", "workspace-docs", "index.ts")).href);
  const workspaceDocs = (await import(pathToFileURL(extensionPath).href)).default;
  const tools = new Map();
  workspaceDocs({
    on: () => {},
    registerTool: (definition) => tools.set(definition.name, definition),
    registerCommand: () => {},
  });

  const cwd = join(scratch, "workspace");
  const ws = core.openWorkspace(cwd);
  ws.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
  ws.createDocument({ id: "beta", title: "Beta", type: "design" });
  setBody(ws, "alpha", ["## Scope {#scope}", "", "x".repeat(80_000), ""].join("\n"));

  const call = async (name, params, root = cwd) => {
    const tool = tools.get(name);
    assert.ok(tool, `${name} is not registered`);
    const result = await tool.execute("call-1", params, undefined, undefined, { cwd: root });
    return result.details;
  };

  await check("D-14", "discovery bounds are clamped, counted, and ordered", async () => {
    const page = await call("docs_discover", { limit: 10_000 });
    assert.equal(page.ok, true);
    assert.ok(page.entries.length <= 200, "limit clamps to 200");
    assert.ok(page.total >= 2, "total is independent of the page");
    assert.deepEqual(
      page.entries.map((entry) => entry.id),
      [...page.entries.map((entry) => entry.id)].sort(),
      "entries are ordered by id",
    );
  });

  await check("D-14", "docs_read returns not-found for a missing id", async () => {
    const missing = await call("docs_read", { id: "nope" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.kind, "not-found");
  });

  await check("D-14", "docs_read bounds bodies and reports omitted identities", async () => {
    const read = await call("docs_read", { id: "alpha" });
    assert.equal(read.ok, true);
    assert.equal(read.truncated, true, "an oversized body is truncated");
    assert.ok(read.omitted.includes("section:scope"), "omitted identities are listed");
    assert.ok(Array.isArray(read.sections), "identities are still returned");
  });

  // Targeted reads: a selector narrows a read to one entity so a reviewer does
  // not pull the whole document (D-19, AC-71/AC-72).
  const selectorRoot = join(scratch, "read-selector");
  const selectorSeed = core.openWorkspace(selectorRoot);
  selectorSeed.createDocument({ id: "gamma", title: "Gamma", type: "specification" });
  setBody(selectorSeed, "gamma", [
    "## Scope {#scope}",
    "",
    "Section prose.",
    "",
    "## Notes {#notes}",
    "",
    "More prose.",
    "",
    "```docs-record",
    'id = "REQ-1"',
    'type = "requirement"',
    "",
    "The requirement.",
    "```",
    "",
    "```docs-term",
    'id = "term-one"',
    'name = "Term one"',
    "",
    "The term.",
    "```",
    "",
    "```docs-link",
    'from = "#REQ-1"',
    'to = "#scope"',
    'type = "references"',
    "```",
    "",
  ].join("\n"));
  selectorSeed.close();

  await check("AC-71", "docs_read returns only the selected entity", async () => {
    const section = await call("docs_read", { id: "gamma", selector: "section:scope" }, selectorRoot);
    assert.equal(section.ok, true);
    assert.equal(section.sections.length, 1, "only the selected section is returned");
    assert.equal(section.sections[0].id, "scope");
    assert.deepEqual(section.records, [], "unselected entities are empty");
    assert.deepEqual(section.terms, []);
    assert.deepEqual(section.links, []);

    const record = await call("docs_read", { id: "gamma", selector: "record:REQ-1" }, selectorRoot);
    assert.equal(record.ok, true);
    assert.equal(record.records.length, 1);
    assert.match(record.records[0].body, /The requirement/);

    const term = await call("docs_read", { id: "gamma", selector: "term:term-one" }, selectorRoot);
    assert.equal(term.ok, true);
    assert.equal(term.terms.length, 1);

    const link = await call("docs_read", { id: "gamma", selector: "link:#REQ-1->#scope" }, selectorRoot);
    assert.equal(link.ok, true);
    assert.equal(link.links.length, 1);

    const small = await call("docs_read", { id: "gamma", selector: "section:scope", maxBytes: 4 }, selectorRoot);
    assert.equal(small.ok, true);
    assert.equal(small.sections[0].body, undefined, "the budget applies to the selected entity");
    assert.ok(small.omitted.includes("section:scope"), "the omitted label is reported");
    assert.equal(small.truncated, true);
  });

  await check("AC-72", "docs_read rejects a malformed, unknown-kind, or missing selector", async () => {
    const malformed = await call("docs_read", { id: "gamma", selector: "scope" }, selectorRoot);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.kind, "invalid-argument");
    const unknown = await call("docs_read", { id: "gamma", selector: "widget:x" }, selectorRoot);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.kind, "invalid-argument");
    const missing = await call("docs_read", { id: "gamma", selector: "record:NOPE" }, selectorRoot);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.kind, "not-found");
  });

  await check("AC-76", "docs_read link selection is type-aware and rejects an ambiguous selector", async () => {
    const linkRoot = join(scratch, "link-selector");
    const linkSeed = core.openWorkspace(linkRoot);
    linkSeed.createDocument({ id: "delta", title: "Delta", type: "specification" });
    setBody(linkSeed, "delta", [
      "## Scope {#scope}",
      "",
      "```docs-record",
      'id = "REQ-1"',
      'type = "requirement"',
      "",
      "It MUST work.",
      "```",
      "",
      "```docs-link",
      'from = "#REQ-1"',
      'to = "#scope"',
      'type = "references"',
      "",
      "Reference body.",
      "```",
      "",
      "```docs-link",
      'from = "#REQ-1"',
      'to = "#scope"',
      'type = "depends-on"',
      "",
      "Depends body.",
      "```",
      "",
    ].join("\n"));
    linkSeed.close();

    const typed = await call("docs_read", { id: "delta", selector: "link:references:#REQ-1->#scope" }, linkRoot);
    assert.equal(typed.ok, true);
    assert.equal(typed.links.length, 1, "the type-qualified selector returns one link");
    assert.equal(typed.links[0].type, "references");

    const ambiguous = await call("docs_read", { id: "delta", selector: "link:#REQ-1->#scope" }, linkRoot);
    assert.equal(ambiguous.ok, false, "an endpoint-only selector with two matches is rejected");
    assert.equal(ambiguous.error.kind, "invalid-argument");
    assert.deepEqual(ambiguous.error.types.sort(), ["depends-on", "references"], "the error names the matching types");
  });

  await check("D-14", "docs_checkout writes a candidate and never overwrites an edit", async () => {
    const first = await call("docs_checkout", { id: "alpha" });
    assert.equal(first.ok, true);
    assert.equal(first.path, ".pi/workspace-docs/checkout/alpha.md");
    const candidatePath = join(cwd, first.path);
    assert.ok(existsSync(candidatePath), "the candidate file is written");

    writeFileSync(candidatePath, "edited by the author\n");
    const conflict = await call("docs_checkout", { id: "alpha" });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.kind, "checkout-conflict");
    assert.equal(readFileSync(candidatePath, "utf8"), "edited by the author\n", "the edit is preserved");

    const replaced = await call("docs_checkout", { id: "alpha", overwrite: true });
    assert.equal(replaced.ok, true, "an explicit overwrite is allowed");
    assert.notEqual(readFileSync(candidatePath, "utf8"), "edited by the author\n");
  });

  await check("D-14", "docs_compile renders without publishing by default", async () => {
    const outPath = join(cwd, ".pi", "workspace-docs", "out", "alpha.md");
    const rendered = await call("docs_compile", {});
    assert.equal(rendered.ok, true);
    assert.ok(Array.isArray(rendered.files), "files are rendered");
    assert.ok(!existsSync(outPath), "the default does not write outputs");
  });

  await check("D-14", "partial publication is reported as incomplete with diagnostics", async () => {
    const outPath = join(cwd, ".pi", "workspace-docs", "out", "alpha.md");
    const published = await call("docs_compile", { publish: true });
    assert.equal(published.ok, true);
    assert.equal(published.complete, true, "the first publication completes");
    assert.ok(existsSync(outPath), "the output is written");

    writeFileSync(outPath, "externally edited\n");
    const partial = await call("docs_compile", { publish: true });
    assert.equal(partial.ok, true);
    assert.equal(partial.complete, false, "partial publication is not complete success");
    assert.ok(partial.diagnostics.some((d) => d.code === "external-edit"), "publication diagnostics are included");
    assert.ok(partial.outcomes.some((outcome) => outcome.action === "blocked"), "outcomes are included");
  });

  await check("D-14", "an unavailable store is distinct from a domain rejection", async () => {
    const badRoot = join(scratch, "bad");
    mkdirSync(join(badRoot, ".pi", "workspace-docs"), { recursive: true });
    writeFileSync(join(badRoot, ".pi", "workspace-docs", "store.sqlite"), "not a database\n".repeat(64));
    const unavailable = await call("docs_validate", {}, badRoot);
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.error.kind, "unavailable");
  });

  await check("D-14", "preview returns the candidate hash alongside the token", async () => {
    const preview = await call("docs_preview_import", { text: ws.checkout("beta").text });
    assert.equal(preview.ok, true);
    assert.equal(typeof preview.token, "string");
    assert.equal(typeof preview.candidateHash, "string");
  });

  await check("D-14", "docs_create invents no lifecycle value", async () => {
    const created = await call("docs_create", { id: "delta", title: "Delta", type: "design" });
    assert.equal(created.ok, true);
    assert.equal(created.status, "committed");
    const readBack = await call("docs_read", { id: "delta" });
    assert.equal(readBack.document.status, undefined, "no lifecycle default is invented");
  });

  await check("D-14", "docs_terms with no match returns an empty counted list", async () => {
    const terms = await call("docs_terms", { query: "no-such-term" });
    assert.equal(terms.ok, true);
    assert.equal(terms.total, 0);
    assert.deepEqual(terms.terms ?? terms.matches, []);
  });

  await check("D-14", "docs_references returns not-found for an unknown target", async () => {
    const missing = await call("docs_references", { target: "nope#missing" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.kind, "not-found");
    const known = await call("docs_references", { target: "alpha" });
    assert.equal(known.ok, true);
    assert.ok(Array.isArray(known.references));
  });

  await check("D-14", "a corrupt publication state is reported and never complete", async () => {
    const badPubRoot = join(scratch, "badpub");
    const seed = core.openWorkspace(badPubRoot);
    seed.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
    seed.close();
    writeFileSync(join(badPubRoot, ".pi", "workspace-docs", "publication.json"), "{ not json\n");
    const result = await call("docs_compile", { publish: true }, badPubRoot);
    assert.equal(result.ok, true);
    assert.equal(result.complete, false, "a blocking diagnostic without a per-path outcome is not complete");
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.severity === "block"),
      "the publication-state failure is reported",
    );
  });

  await check("AC-48", "the extension records approver lists and rejects a malformed list", async () => {
    const envRoot = join(scratch, "env-authority");
    const seed = core.openWorkspace(envRoot);
    seed.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
    const checkout = seed.checkout("alpha").text;
    seed.close();
    const frontMatter = checkout.match(/^\+\+\+\n[\s\S]*?\n\+\+\+\n/)[0];

    const candidate =
      frontMatter +
      ["```docs-record", 'id = "DEC-1"', 'type = "decision"', 'approval = "approved"', 'approved-users = ["kevin"]', 'approved-agents = ["opencode-go/deepseek-v4.1-flash"]', "", "Approved.", "```", ""].join("\n");
    const preview = await call("docs_preview_import", { text: candidate }, envRoot);
    assert.equal(preview.ok, true);
    assert.ok(!preview.diagnostics.some((diagnostic) => diagnostic.severity === "block"));
    const imported = await call("docs_import", { text: candidate, token: preview.token }, envRoot);
    assert.equal(imported.ok, true);
    assert.equal(imported.status, "committed");

    const malformed =
      frontMatter +
      ["```docs-record", 'id = "DEC-2"', 'type = "decision"', 'approval = "approved"', 'approved-users = "kevin"', "", "Approved.", "```", ""].join("\n");
    const bad = await call("docs_preview_import", { text: malformed }, envRoot);
    assert.equal(bad.ok, true);
    assert.ok(
      bad.diagnostics.some((diagnostic) => diagnostic.severity === "block" && diagnostic.code === "record-approval"),
      "a non-list approver value blocks",
    );
  });

  await check("AC-52", "docs_compile forwards reconcile entries and reports completion", async () => {
    const recRoot = join(scratch, "reconcile");
    const seed = core.openWorkspace(recRoot);
    seed.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
    seed.publish();
    seed.close();
    const outPath = join(recRoot, ".pi", "workspace-docs", "out", "alpha.md");
    writeFileSync(outPath, "externally edited\n");

    const blocked = await call("docs_compile", { publish: true }, recRoot);
    assert.equal(blocked.complete, false, "an external edit is not complete");
    assert.ok(blocked.outcomes.some((outcome) => outcome.code === "external-edit"));

    const reconciled = await call(
      "docs_compile",
      { publish: true, reconcile: [{ path: ".pi/workspace-docs/out/alpha.md", action: "replace" }] },
      recRoot,
    );
    assert.equal(reconciled.complete, true, "the reconciled publication completes");
    assert.ok(reconciled.outcomes.some((outcome) => outcome.code === "replace"), "the reconcile code is returned");
    assert.match(readFileSync(outPath, "utf8"), /generated by workspace-docs/);

    const ineligible = await call(
      "docs_compile",
      { publish: true, reconcile: [{ path: "docs/unknown.md", action: "replace" }] },
      recRoot,
    );
    assert.equal(ineligible.complete, false, "an ineligible reconcile path is not complete");
    assert.ok(ineligible.outcomes.some((outcome) => outcome.code === "reconcile-ineligible"));
  });
  // --- Candidate-path authoring (AC-56 through AC-60) --------------------
  //
  // The candidate file is the editing surface. Checkout returns a path, not
  // the document text, and preview/import read the candidate by path so the
  // whole document never has to pass through a tool call.

  await check("AC-56", "docs_checkout returns the candidate path without the document text", async () => {
    const checkout = await call("docs_checkout", { id: "alpha", overwrite: true });
    assert.equal(checkout.ok, true);
    assert.equal(checkout.path, ".pi/workspace-docs/checkout/alpha.md");
    assert.equal(checkout.text, undefined, "the document text is not returned");
    assert.equal(typeof checkout.baseRevision, "number");
    assert.equal(typeof checkout.baseStoreRevision, "number");
    assert.equal(typeof checkout.bytes, "number");
    assert.equal(typeof checkout.lines, "number");
    const onDisk = readFileSync(join(cwd, checkout.path), "utf8");
    assert.equal(checkout.bytes, Buffer.byteLength(onDisk, "utf8"), "bytes match the candidate file");
  });

  await check("AC-57", "docs_preview_import reads a checkout candidate by path", async () => {
    const checkout = await call("docs_checkout", { id: "beta", overwrite: true });
    const onDisk = readFileSync(join(cwd, checkout.path), "utf8");
    const byText = await call("docs_preview_import", { text: onDisk });
    const byPath = await call("docs_preview_import", { path: checkout.path });
    assert.equal(byPath.ok, true, JSON.stringify(byPath.error ?? {}));
    assert.equal(byPath.token, byText.token, "the path form binds the same candidate bytes");
    assert.equal(byPath.candidateHash, byText.candidateHash);
  });

  await check("AC-58", "docs_import reads a checkout candidate by path and rejects a changed file", async () => {
    const checkout = await call("docs_checkout", { id: "beta", overwrite: true });
    const candidatePath = join(cwd, checkout.path);
    writeFileSync(candidatePath, readFileSync(candidatePath, "utf8").replace("Beta", "Beta edited"));
    const preview = await call("docs_preview_import", { path: checkout.path });
    const imported = await call("docs_import", { path: checkout.path, token: preview.token });
    assert.equal(imported.ok, true, JSON.stringify(imported.error ?? {}));
    assert.equal(imported.status, "committed", "a path-based preview commits");

    const stalePreview = await call("docs_preview_import", { path: checkout.path });
    writeFileSync(candidatePath, readFileSync(candidatePath, "utf8").replace("edited", "edited again"));
    const changed = await call("docs_import", { path: checkout.path, token: stalePreview.token });
    assert.equal(changed.ok, true);
    assert.equal(changed.status, "rejected", "an edit after preview is rejected");
    assert.ok(changed.diagnostics.some((diagnostic) => diagnostic.code === "candidate-changed"));
  });

  await check("AC-59", "a candidate path outside the checkout directory is rejected", async () => {
    const outside = join(cwd, "docs", "not-a-candidate.md");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, "not a candidate\n");
    for (const toolName of ["docs_preview_import", "docs_import"]) {
      const result = await call(toolName, { path: "docs/not-a-candidate.md", token: "token" });
      assert.equal(result.ok, false, `${toolName} rejects the path`);
      assert.equal(result.error.kind, "invalid-argument", `${toolName} kind`);
    }
  });

  await check("AC-60", "exactly one of text or path is required", async () => {
    const checkout = await call("docs_checkout", { id: "beta", overwrite: true });
    const text = readFileSync(join(cwd, checkout.path), "utf8");
    for (const [label, params] of [
      ["both", { text, path: checkout.path }],
      ["neither", {}],
    ]) {
      const preview = await call("docs_preview_import", params);
      assert.equal(preview.ok, false, `preview ${label}`);
      assert.equal(preview.error.kind, "invalid-argument", `preview ${label}`);
      const imported = await call("docs_import", { ...params, token: "token" });
      assert.equal(imported.ok, false, `import ${label}`);
      assert.equal(imported.error.kind, "invalid-argument", `import ${label}`);
    }
  });

  // --- Compile summaries (AC-61, AC-62) -----------------------------------
  //
  // Compilation must not return rendered document bodies. The caller reads a
  // published file from disk or a stored document through docs_read.

  await check("AC-61", "docs_compile returns content-free file summaries without publishing", async () => {
    const root = join(scratch, "compile-summary");
    const seed = core.openWorkspace(root);
    seed.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
    setBody(seed, "alpha", ["## Scope {#scope}", "", "body text", ""].join("\n"));
    seed.close();
    const rendered = await call("docs_compile", {}, root);
    assert.equal(rendered.ok, true, JSON.stringify(rendered.error ?? {}));
    assert.ok(Array.isArray(rendered.files) && rendered.files.length > 0, "files are listed");
    for (const file of rendered.files) {
      assert.equal(typeof file.path, "string", "path is a string");
      assert.equal(typeof file.bytes, "number", "bytes is a number");
      assert.equal(typeof file.lines, "number", "lines is a number");
      assert.equal(file.content, undefined, `${file.path} does not carry its rendered body`);
    }
    assert.ok(!existsSync(join(root, ".pi", "workspace-docs", "out", "alpha.md")), "render-only writes nothing");
  });

  await check("AC-62", "docs_compile publish reports outcomes and a content-free summary", async () => {
    const root = join(scratch, "compile-publish-summary");
    const seed = core.openWorkspace(root);
    seed.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
    setBody(seed, "alpha", ["## Scope {#scope}", "", "published body", ""].join("\n"));
    seed.close();
    const published = await call("docs_compile", { publish: true }, root);
    assert.equal(published.ok, true, JSON.stringify(published.error ?? {}));
    assert.equal(published.complete, true, "the publication completes");
    for (const file of published.files) {
      assert.equal(file.content, undefined, `${file.path} does not carry its rendered body`);
    }
    const summary = published.files.find((file) => file.path === ".pi/workspace-docs/out/alpha.md");
    assert.ok(summary, "the output path is summarized");
    const onDisk = readFileSync(join(root, ".pi", "workspace-docs", "out", "alpha.md"), "utf8");
    assert.equal(summary.bytes, Buffer.byteLength(onDisk, "utf8"), "the summary matches the published bytes");
    assert.match(onDisk, /published body/);
  });

  // D-18 structured authoring, first slice: docs_record_add as a candidate
  // producer (REQ-TOOL-5, REQ-TOOL-10; AC-63, AC-69, AC-70).
  const recordAddRoot = (name) => {
    const root = join(scratch, name);
    const seed = core.openWorkspace(root);
    seed.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
    setBody(seed, "alpha", ["## Scope {#scope}", "", "Prose.", ""].join("\n"));
    seed.close();
    return root;
  };
  const candidateFile = (root) => join(root, ".pi", "workspace-docs", "checkout", "alpha.md");

  // A fixture with a section, a record, a term, a link, and a second section.
  const D18_BODY = [
    "## Scope {#scope}",
    "",
    "Scope prose.",
    "",
    "```docs-record",
    'id = "REQ-1"',
    'type = "requirement"',
    "",
    "It MUST work.",
    "```",
    "",
    "```docs-term",
    'id = "store"',
    'name = "Store"',
    "",
    "The collection.",
    "```",
    "",
    "```docs-link",
    'from = "#REQ-1"',
    'to = "alpha"',
    'type = "references"',
    "```",
    "",
    "## Detail {#detail}",
    "",
    "Detail prose.",
    "",
  ].join("\n");
  const d18Root = (name) => {
    const root = join(scratch, name);
    const seed = core.openWorkspace(root);
    seed.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
    seed.createDocument({ id: "beta", title: "Beta", type: "design" });
    setBody(seed, "alpha", D18_BODY);
    setBody(seed, "beta", ["## Notes {#notes}", "", "Beta prose.", ""].join("\n"));
    seed.close();
    return root;
  };

  await check("AC-63", "docs_record_add returns a candidate and token and commits nothing", async () => {
    const root = recordAddRoot("record-add");
    const before = core.openWorkspace(root).read().storeRevision;
    const result = await call(
      "docs_record_add",
      { doc: "alpha", id: "REQ-1", type: "requirement", body: "It MUST work.", section: "scope" },
      root,
    );
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}));
    assert.equal(typeof result.token, "string", "a preview token is returned");
    assert.equal(result.path, ".pi/workspace-docs/checkout/alpha.md");
    assert.ok(existsSync(candidateFile(root)), "the candidate is written");

    const untouched = core.openWorkspace(root);
    assert.equal(untouched.read().storeRevision, before, "no store commit before import");
    untouched.close();

    const imported = await call("docs_import", { path: ".pi/workspace-docs/checkout/alpha.md", token: result.token }, root);
    assert.equal(imported.status, "committed", "explicit import commits");
    const committed = core.openWorkspace(root);
    assert.equal(committed.read().storeRevision, before + 1, "the store revision moves once");
    committed.close();
  });

  await check("AC-69", "docs_record_add preserves a current candidate and refuses a stale one", async () => {
    const root = recordAddRoot("record-add-conflict");
    await call("docs_checkout", { id: "alpha" }, root);
    writeFileSync(candidateFile(root), `${readFileSync(candidateFile(root), "utf8")}\nManual note.\n`);

    const first = await call(
      "docs_record_add",
      { doc: "alpha", id: "REQ-1", type: "requirement", body: "It MUST work.", section: "scope" },
      root,
    );
    assert.equal(first.ok, true, JSON.stringify(first.error ?? {}));
    const afterFirst = readFileSync(candidateFile(root), "utf8");
    assert.ok(afterFirst.includes("Manual note."), "the unsaved manual edit is preserved");
    assert.ok(afterFirst.includes('id = "REQ-1"'), "the structured edit is applied");

    const advanced = core.openWorkspace(root);
    setBody(advanced, "alpha", ["## Scope {#scope}", "", "Moved prose.", ""].join("\n"));
    advanced.close();

    const stale = await call(
      "docs_record_add",
      { doc: "alpha", id: "REQ-2", type: "requirement", body: "Second.", section: "scope" },
      root,
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.error.kind, "checkout-conflict");
    assert.equal(readFileSync(candidateFile(root), "utf8"), afterFirst, "a stale candidate is left unchanged");

    const overwritten = await call(
      "docs_record_add",
      { doc: "alpha", id: "REQ-3", type: "requirement", body: "Third.", section: "scope", overwrite: true },
      root,
    );
    assert.equal(overwritten.ok, true, JSON.stringify(overwritten.error ?? {}));
    assert.ok(!readFileSync(candidateFile(root), "utf8").includes("Manual note."), "overwrite discards old bytes");
  });

  await check("AC-70", "a structured candidate cannot be imported after it changes", async () => {
    const root = recordAddRoot("record-add-token");
    const added = await call(
      "docs_record_add",
      { doc: "alpha", id: "REQ-1", type: "requirement", body: "It MUST work.", section: "scope" },
      root,
    );
    assert.equal(added.ok, true, JSON.stringify(added.error ?? {}));
    writeFileSync(candidateFile(root), `${readFileSync(candidateFile(root), "utf8")}\nChanged.\n`);

    const imported = await call("docs_import", { path: ".pi/workspace-docs/checkout/alpha.md", token: added.token }, root);
    assert.equal(imported.ok, true, JSON.stringify(imported.error ?? {}));
    assert.equal(imported.status, "rejected");
    assert.ok(
      imported.diagnostics.some((diagnostic) => diagnostic.code === "candidate-changed"),
      "the changed candidate is rejected",
    );
  });

  await check("AC-64", "docs_record_update writes a candidate without committing and preserves unrelated bytes", async () => {
    const root = recordAddRoot("record-update");
    const opened = core.openWorkspace(root);
    const revBefore = opened.read().storeRevision;
    opened.close();
    const added = await call(
      "docs_record_add",
      { doc: "alpha", id: "REQ-1", type: "requirement", body: "It MUST work.", section: "scope" },
      root,
    );
    assert.equal(added.ok, true, JSON.stringify(added.error ?? {}));
    const before = readFileSync(candidateFile(root), "utf8");

    const updated = await call(
      "docs_record_update",
      { doc: "alpha", id: "REQ-1", status: "approved", title: "Renamed" },
      root,
    );
    assert.equal(updated.ok, true, JSON.stringify(updated.error ?? {}));
    const after = readFileSync(candidateFile(root), "utf8");
    assert.ok(after.includes('status = "approved"'), "the field is replaced");
    assert.ok(after.includes('title = "Renamed"'), "the field is added");
    assert.ok(after.includes("It MUST work."), "the body is preserved");
    assert.ok(after.startsWith(before.match(/^\+\+\+\n[\s\S]*?\n\+\+\+\n/)[0]), "front matter is preserved");
    assert.ok(after.includes("## Scope {#scope}"), "the section is preserved");
    const openedAfter = core.openWorkspace(root);
    assert.equal(openedAfter.read().storeRevision, revBefore, "no commit before import");
    openedAfter.close();
  });

  await check("AC-66", "docs_record_delete blocks a referenced record and commits an unreferenced one", async () => {
    const root = join(scratch, "record-delete");
    const seed = core.openWorkspace(root);
    seed.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
    seed.createDocument({ id: "beta", title: "Beta", type: "design" });
    setBody(
      seed,
      "alpha",
      [
        "## Scope {#scope}",
        "",
        "```docs-record",
        'id = "REQ-1"',
        'type = "requirement"',
        "",
        "It MUST work.",
        "```",
        "",
        "```docs-record",
        'id = "REQ-2"',
        'type = "requirement"',
        "",
        "It MUST also work.",
        "```",
        "",
      ].join("\n"),
    );
    setBody(
      seed,
      "beta",
      [
        "## Notes {#notes}",
        "",
        "```docs-record",
        'id = "REQ-9"',
        'type = "requirement"',
        "",
        "Beta MUST exist.",
        "```",
        "",
        "```docs-link",
        'from = "#REQ-9"',
        'to = "alpha#REQ-1"',
        'type = "references"',
        "```",
        "",
      ].join("\n"),
    );
    seed.close();

    const blocked = await call("docs_record_delete", { doc: "alpha", id: "REQ-1" }, root);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.kind, "rejected");
    assert.ok(
      blocked.error.diagnostics.some((diagnostic) => diagnostic.code === "referenced"),
      "the referenced deletion is blocked",
    );
    assert.ok(!existsSync(candidateFile(root)), "a blocked deletion writes no candidate");

    const removed = await call("docs_record_delete", { doc: "alpha", id: "REQ-2" }, root);
    assert.equal(removed.ok, true, JSON.stringify(removed.error ?? {}));
    const imported = await call("docs_import", { path: ".pi/workspace-docs/checkout/alpha.md", token: removed.token }, root);
    assert.equal(imported.status, "committed", "an unreferenced deletion commits");
    const committed = core.openWorkspace(root);
    const parsed = core.parseCandidate(committed.checkout("alpha").text);
    assert.ok(!parsed.records.some((entry) => entry.id === "REQ-2"), "the record is gone");
    committed.close();
  });

  await check("AC-65", "docs_link_add and docs_link_remove change only the matching link", async () => {
    const root = recordAddRoot("link-tools");
    const first = await call(
      "docs_link_add",
      { doc: "alpha", from: "#scope", to: "alpha", type: "references", section: "scope" },
      root,
    );
    assert.equal(first.ok, true, JSON.stringify(first.error ?? {}));
    const second = await call(
      "docs_link_add",
      { doc: "alpha", from: "#scope", to: "beta", type: "depends-on", section: "scope" },
      root,
    );
    assert.equal(second.ok, true, JSON.stringify(second.error ?? {}));
    assert.equal((readFileSync(candidateFile(root), "utf8").match(/```docs-link/g) ?? []).length, 2, "both links are present");

    const removed = await call(
      "docs_link_remove",
      { doc: "alpha", from: "#scope", to: "alpha", type: "references" },
      root,
    );
    assert.equal(removed.ok, true, JSON.stringify(removed.error ?? {}));
    const after = readFileSync(candidateFile(root), "utf8");
    assert.ok(!after.includes('to = "alpha"'), "the matching link is removed");
    assert.ok(after.includes('to = "beta"'), "the other link remains");
    assert.ok(!after.includes("docs-delete"), "link removal uses no docs-delete directive");

    const missing = await call("docs_link_remove", { doc: "alpha", from: "#scope", to: "nope", type: "references" }, root);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.kind, "not-found");
  });

  await check("AC-65", "docs_term_add rejects an invalid term without writing", async () => {
    const root = recordAddRoot("term-tools");
    const bad = await call(
      "docs_term_add",
      { doc: "alpha", id: "bad", name: "Bad", scope: "global", section: "scope" },
      root,
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.error.kind, "rejected");
    assert.ok(!existsSync(candidateFile(root)), "an invalid term writes no candidate");

    const good = await call("docs_term_add", { doc: "alpha", id: "store", name: "Store", section: "scope" }, root);
    assert.equal(good.ok, true, JSON.stringify(good.error ?? {}));
    const imported = await call("docs_import", { path: ".pi/workspace-docs/checkout/alpha.md", token: good.token }, root);
    assert.equal(imported.status, "committed");
  });

  await check("AC-67", "docs_section_add and docs_prose_insert write a candidate without committing", async () => {
    const root = recordAddRoot("section-tools");
    const opened = core.openWorkspace(root);
    const revBefore = opened.read().storeRevision;
    opened.close();

    const added = await call(
      "docs_section_add",
      { doc: "alpha", id: "detail", heading: "Detail", depth: 2, body: "Detail prose.", section: "scope" },
      root,
    );
    assert.equal(added.ok, true, JSON.stringify(added.error ?? {}));
    const inserted = await call("docs_prose_insert", { doc: "alpha", text: "Inserted note.", section: "detail" }, root);
    assert.equal(inserted.ok, true, JSON.stringify(inserted.error ?? {}));
    const candidate = readFileSync(candidateFile(root), "utf8");
    assert.ok(candidate.includes("## Detail {#detail}"), "the section is added");
    assert.ok(candidate.includes("Inserted note."), "the prose is inserted");
    const openedAfter = core.openWorkspace(root);
    assert.equal(openedAfter.read().storeRevision, revBefore, "no commit before import");
    openedAfter.close();
  });

  await check("AC-67", "docs_section_move relocates a section verbatim through the tools", async () => {
    const root = join(scratch, "section-move");
    const seed = core.openWorkspace(root);
    seed.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
    setBody(
      seed,
      "alpha",
      [
        "## Alpha {#alpha}",
        "",
        "Alpha prose.",
        "",
        "### Alpha child {#alpha-child}",
        "",
        "Child prose.",
        "",
        "```docs-record",
        'id = "REQ-A"',
        'type = "requirement"',
        "",
        "Alpha MUST hold.",
        "```",
        "",
        "## Beta {#beta}",
        "",
        "Beta prose.",
        "",
      ].join("\n"),
    );
    seed.close();

    const moved = await call("docs_section_move", { doc: "alpha", id: "alpha", section: "beta" }, root);
    assert.equal(moved.ok, true, JSON.stringify(moved.error ?? {}));
    const candidate = readFileSync(candidateFile(root), "utf8");
    const alpha = [
      "## Alpha {#alpha}",
      "",
      "Alpha prose.",
      "",
      "### Alpha child {#alpha-child}",
      "",
      "Child prose.",
      "",
      "```docs-record",
      'id = "REQ-A"',
      'type = "requirement"',
      "",
      "Alpha MUST hold.",
      "```",
    ].join("\n");
    assert.ok(candidate.includes(alpha), "the section is byte-identical");
    assert.ok(candidate.indexOf(alpha) > candidate.indexOf("## Beta {#beta}"), "it is placed after Beta");
  });

  await check("AC-63", "each of the twelve D-18 tools produces a candidate and token without committing", async () => {
    const root = d18Root("ac63");
    const opened = core.openWorkspace(root);
    const before = opened.read().storeRevision;
    opened.close();
    const calls = [
      ["docs_record_add", { doc: "alpha", id: "REQ-2", type: "requirement", body: "Second.", section: "scope" }],
      ["docs_record_update", { doc: "alpha", id: "REQ-1", title: "Renamed" }],
      ["docs_record_delete", { doc: "alpha", id: "REQ-2" }],
      ["docs_term_add", { doc: "alpha", id: "doc", name: "Document", section: "scope" }],
      ["docs_term_update", { doc: "alpha", id: "store", name: "Repository" }],
      ["docs_term_delete", { doc: "alpha", id: "doc" }],
      ["docs_link_add", { doc: "alpha", from: "#REQ-1", to: "beta", type: "depends-on", section: "scope" }],
      ["docs_link_remove", { doc: "alpha", from: "#REQ-1", to: "alpha", type: "references" }],
      ["docs_section_add", { doc: "alpha", id: "extra", heading: "Extra", depth: 2, body: "Extra prose.", section: "scope" }],
      ["docs_section_move", { doc: "alpha", id: "detail", section: "scope" }],
      ["docs_section_setBody", { doc: "alpha", id: "scope", text: "Replaced." }],
      ["docs_prose_insert", { doc: "alpha", text: "Inserted.", section: "extra" }],
    ];
    let last;
    for (const [name, params] of calls) {
      const result = await call(name, params, root);
      assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.error ?? {})}`);
      assert.equal(typeof result.token, "string", `${name} returns a preview token`);
      assert.ok(existsSync(candidateFile(root)), `${name} writes a candidate`);
      const current = core.openWorkspace(root);
      assert.equal(current.read().storeRevision, before, `${name} does not commit`);
      current.close();
      last = result;
    }
    const imported = await call("docs_import", { path: ".pi/workspace-docs/checkout/alpha.md", token: last.token }, root);
    assert.equal(imported.status, "committed", "explicit import commits");
    const after = core.openWorkspace(root);
    assert.equal(after.read().storeRevision, before + 1, "only import moves the store revision");
    after.close();
  });

  await check("AC-64", "record and term updates change only the named block", async () => {
    const root = d18Root("ac64");
    await call("docs_checkout", { id: "alpha" }, root);
    const before = readFileSync(candidateFile(root), "utf8");
    const front = before.match(/^\+\+\+\n[\s\S]*?\n\+\+\+\n/)[0];
    const toc = before.match(/<!-- docs:generated:toc -->\n[\s\S]*?\n<!-- \/docs:generated:toc -->/)?.[0];
    assert.ok(toc, "the checkout carries a toc region");
    const increasing = (text) => {
      const indices = ["docs-record", "docs-term", "docs-link"].map((name) => text.indexOf("```" + name));
      return indices.every((value, index) => index === 0 || indices[index - 1] < value);
    };
    assert.ok(increasing(before), "the fixture orders record, term, then link");

    const record = await call(
      "docs_record_update",
      { doc: "alpha", id: "REQ-1", title: "Renamed", body: "It MUST still work." },
      root,
    );
    assert.equal(record.ok, true, JSON.stringify(record.error ?? {}));
    const term = await call("docs_term_update", { doc: "alpha", id: "store", name: "Repository" }, root);
    assert.equal(term.ok, true, JSON.stringify(term.error ?? {}));

    const after = readFileSync(candidateFile(root), "utf8");
    assert.ok(after.startsWith(front), "front matter is preserved");
    assert.equal(
      after.match(/<!-- docs:generated:toc -->\n[\s\S]*?\n<!-- \/docs:generated:toc -->/)?.[0],
      toc,
      "the toc is preserved",
    );
    assert.ok(after.includes("Scope prose.") && after.includes("Detail prose."), "unrelated prose is preserved");
    assert.ok(increasing(after), "block order is unchanged");
    const parsed = core.parseCandidate(after);
    assert.equal(parsed.records.find((entry) => entry.id === "REQ-1").title, "Renamed");
    assert.equal(parsed.records.find((entry) => entry.id === "REQ-1").body, "It MUST still work.");
    assert.equal(parsed.terms.find((entry) => entry.id === "store").name, "Repository");
  });

  await check("AC-65", "adds insert one block at the anchor and link removal removes only the match", async () => {
    const root = d18Root("ac65");
    const record = await call(
      "docs_record_add",
      { doc: "alpha", id: "REQ-2", type: "requirement", body: "Second.", after: "REQ-1" },
      root,
    );
    assert.equal(record.ok, true, JSON.stringify(record.error ?? {}));
    const term = await call("docs_term_add", { doc: "alpha", id: "doc", name: "Document", after: "store" }, root);
    assert.equal(term.ok, true, JSON.stringify(term.error ?? {}));
    const link = await call(
      "docs_link_add",
      { doc: "alpha", from: "#REQ-2", to: "beta", type: "depends-on", after: "REQ-2" },
      root,
    );
    assert.equal(link.ok, true, JSON.stringify(link.error ?? {}));

    const afterAdds = readFileSync(candidateFile(root), "utf8");
    const parsed = core.parseCandidate(afterAdds);
    assert.ok(parsed.records.some((entry) => entry.id === "REQ-2"), "the record is added");
    assert.ok(parsed.terms.some((entry) => entry.id === "doc"), "the term is added");
    assert.ok(parsed.links.some((entry) => entry.to === "beta"), "the link is added");
    assert.ok(afterAdds.indexOf('id = "REQ-2"') > afterAdds.indexOf('id = "REQ-1"'), "the record is after its anchor");

    const removed = await call(
      "docs_link_remove",
      { doc: "alpha", from: "#REQ-1", to: "alpha", type: "references" },
      root,
    );
    assert.equal(removed.ok, true, JSON.stringify(removed.error ?? {}));
    const afterRemove = readFileSync(candidateFile(root), "utf8");
    assert.ok(!afterRemove.includes('to = "alpha"'), "the matching link is removed");
    assert.ok(afterRemove.includes('to = "beta"'), "the other link remains");
    assert.ok(!afterRemove.includes("docs-delete"), "link removal adds no docs-delete");
  });

  await check("AC-66", "deletes replace in place and referenced or omitted records block", async () => {
    const commitRoot = d18Root("ac66-commit");
    const recordDelete = await call("docs_record_delete", { doc: "alpha", id: "REQ-1" }, commitRoot);
    assert.equal(recordDelete.ok, true, JSON.stringify(recordDelete.error ?? {}));
    const termDelete = await call("docs_term_delete", { doc: "alpha", id: "store" }, commitRoot);
    assert.equal(termDelete.ok, true, JSON.stringify(termDelete.error ?? {}));
    const candidate = readFileSync(candidateFile(commitRoot), "utf8");
    assert.ok(candidate.includes('```docs-delete\nid = "REQ-1"\n```'), "the record block is replaced in place");
    assert.ok(candidate.includes('```docs-delete\nid = "store"\n```'), "the term block is replaced in place");
    const imported = await call(
      "docs_import",
      { path: ".pi/workspace-docs/checkout/alpha.md", token: termDelete.token },
      commitRoot,
    );
    assert.equal(imported.status, "committed", "the unreferenced deletions commit");

    const refRoot = join(scratch, "ac66-ref");
    const seed = core.openWorkspace(refRoot);
    seed.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
    seed.createDocument({ id: "beta", title: "Beta", type: "design" });
    setBody(
      seed,
      "alpha",
      ["## Scope {#scope}", "", "```docs-record", 'id = "REQ-1"', 'type = "requirement"', "", "It MUST work.", "```", ""].join("\n"),
    );
    setBody(
      seed,
      "beta",
      [
        "## Notes {#notes}",
        "",
        "```docs-record",
        'id = "REQ-9"',
        'type = "requirement"',
        "",
        "Beta MUST exist.",
        "```",
        "",
        "```docs-link",
        'from = "#REQ-9"',
        'to = "alpha#REQ-1"',
        'type = "references"',
        "```",
        "",
      ].join("\n"),
    );
    seed.close();
    const blocked = await call("docs_record_delete", { doc: "alpha", id: "REQ-1" }, refRoot);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.kind, "rejected");
    assert.ok(
      blocked.error.diagnostics.some((diagnostic) => diagnostic.code === "referenced"),
      "the referenced deletion is blocked",
    );

    const omitRoot = d18Root("ac66-omit");
    await call("docs_checkout", { id: "alpha" }, omitRoot);
    const omitted = readFileSync(candidateFile(omitRoot), "utf8").replace(
      /```docs-record\nid = "REQ-1"\n[\s\S]*?\n```\n/,
      "",
    );
    writeFileSync(candidateFile(omitRoot), omitted);
    const preview = await call("docs_preview_import", { path: ".pi/workspace-docs/checkout/alpha.md" }, omitRoot);
    assert.equal(preview.ok, true);
    assert.ok(
      preview.diagnostics.some((diagnostic) => diagnostic.code === "omission"),
      "the omission blocks",
    );
  });

  await check("AC-67", "section add, move, setBody, and prose insert change only the named range", async () => {
    const root = d18Root("ac67");
    const added = await call(
      "docs_section_add",
      { doc: "alpha", id: "extra", heading: "Extra", depth: 2, body: "Extra prose.", section: "detail" },
      root,
    );
    assert.equal(added.ok, true, JSON.stringify(added.error ?? {}));
    assert.ok(readFileSync(candidateFile(root), "utf8").includes("## Extra {#extra}"), "the heading carries its id");

    const moved = await call("docs_section_move", { doc: "alpha", id: "scope", section: "detail" }, root);
    assert.equal(moved.ok, true, JSON.stringify(moved.error ?? {}));
    const afterMove = readFileSync(candidateFile(root), "utf8");
    const scope = [
      "## Scope {#scope}",
      "",
      "Scope prose.",
      "",
      "```docs-record",
      'id = "REQ-1"',
      'type = "requirement"',
      "",
      "It MUST work.",
      "```",
      "",
      "```docs-term",
      'id = "store"',
      'name = "Store"',
      "",
      "The collection.",
      "```",
      "",
      "```docs-link",
      'from = "#REQ-1"',
      'to = "alpha"',
      'type = "references"',
      "```",
    ].join("\n");
    assert.ok(afterMove.includes(scope), "the moved section is byte-identical");
    assert.ok(afterMove.indexOf(scope) > afterMove.indexOf("## Detail {#detail}"), "it is placed after Detail");

    const set = await call("docs_section_setBody", { doc: "alpha", id: "extra", text: "Replaced body." }, root);
    assert.equal(set.ok, true, JSON.stringify(set.error ?? {}));
    const afterSet = readFileSync(candidateFile(root), "utf8");
    assert.ok(afterSet.includes("## Extra {#extra}"), "the heading is preserved");
    assert.ok(afterSet.includes("Replaced body."), "the new body is present");
    assert.ok(!afterSet.includes("Extra prose."), "the old body is replaced");

    const inserted = await call(
      "docs_prose_insert",
      { doc: "alpha", text: "Inserted after REQ-1.", after: "REQ-1" },
      root,
    );
    assert.equal(inserted.ok, true, JSON.stringify(inserted.error ?? {}));
    const afterInsert = readFileSync(candidateFile(root), "utf8");
    assert.ok(afterInsert.includes("Inserted after REQ-1."), "the prose is verbatim");
    assert.ok(afterInsert.includes("Detail prose."), "unrelated prose is preserved");
  });

  await check("AC-68", "insertion placement is context-dependent and a missing anchor writes nothing", async () => {
    const root = join(scratch, "ac68");
    const seed = core.openWorkspace(root);
    seed.createDocument({ id: "lexicon", title: "Lexicon", type: "note" });
    seed.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
    setBody(
      seed,
      "lexicon",
      ["## Terms {#terms}", "", "```docs-term", 'id = "store"', 'name = "Store"', "", "The collection.", "```", ""].join("\n"),
    );
    setBody(
      seed,
      "alpha",
      [
        "## Alpha {#alpha}",
        "",
        "Alpha prose.",
        "",
        "### Alpha child {#alpha-child}",
        "",
        "Child prose.",
        "",
        "```docs-record",
        'id = "REQ-1"',
        'type = "requirement"',
        "",
        "It MUST work.",
        "```",
        "",
        "```docs-link",
        'from = "#REQ-1"',
        'to = "term:store"',
        'type = "references"',
        "```",
        "",
        "## Beta {#beta}",
        "",
        "Beta prose.",
        "",
      ].join("\n"),
    );
    seed.close();
    await call("docs_checkout", { id: "alpha" }, root);
    const before = readFileSync(candidateFile(root), "utf8");
    assert.ok(before.includes("<!-- docs:generated:glossary -->"), "the checkout carries a glossary region");
    const revBefore = core.openWorkspace(root).read().storeRevision;

    const after = await call("docs_prose_insert", { doc: "alpha", text: "AFTER RECORD", after: "REQ-1" }, root);
    assert.equal(after.ok, true, JSON.stringify(after.error ?? {}));
    const afterBody = readFileSync(candidateFile(root), "utf8");
    assert.ok(afterBody.indexOf("AFTER RECORD") > afterBody.indexOf('id = "REQ-1"'), "after the named block");
    assert.ok(afterBody.indexOf("AFTER RECORD") < afterBody.indexOf("## Beta {#beta}"), "before the next heading");

    const section = await call("docs_prose_insert", { doc: "alpha", text: "AT SECTION END", section: "alpha" }, root);
    assert.equal(section.ok, true, JSON.stringify(section.error ?? {}));
    const sectionBody = readFileSync(candidateFile(root), "utf8");
    assert.ok(sectionBody.indexOf("AT SECTION END") < sectionBody.indexOf("## Beta {#beta}"), "before the next equal heading");
    assert.ok(sectionBody.indexOf("AT SECTION END") > sectionBody.indexOf("### Alpha child"), "after the nested heading");

    const end = await call("docs_prose_insert", { doc: "alpha", text: "AT BODY END" }, root);
    assert.equal(end.ok, true, JSON.stringify(end.error ?? {}));
    const endBody = readFileSync(candidateFile(root), "utf8");
    assert.ok(endBody.indexOf("AT BODY END") < endBody.indexOf("<!-- docs:generated:glossary -->"), "before the generated region");

    const missing = await call("docs_prose_insert", { doc: "alpha", text: "NOPE", after: "NOPE" }, root);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.kind, "not-found");
    assert.equal(readFileSync(candidateFile(root), "utf8"), endBody, "a missing anchor leaves the candidate unchanged");
    const revAfter = core.openWorkspace(root).read().storeRevision;
    assert.equal(revAfter, revBefore, "a missing anchor leaves the store unchanged");
  });

  await check("AC-69", "structured writes accumulate on a current candidate and refuse a stale one", async () => {
    const root = d18Root("ac69");
    await call("docs_checkout", { id: "alpha" }, root);
    writeFileSync(candidateFile(root), `${readFileSync(candidateFile(root), "utf8")}\nManual note.\n`);
    const first = await call(
      "docs_record_add",
      { doc: "alpha", id: "REQ-2", type: "requirement", body: "Second.", section: "scope" },
      root,
    );
    assert.equal(first.ok, true, JSON.stringify(first.error ?? {}));
    const second = await call("docs_term_add", { doc: "alpha", id: "doc", name: "Document", section: "scope" }, root);
    assert.equal(second.ok, true, JSON.stringify(second.error ?? {}));
    const accumulated = readFileSync(candidateFile(root), "utf8");
    assert.ok(accumulated.includes("Manual note."), "the unsaved manual edit is kept");
    assert.ok(accumulated.includes('id = "REQ-2"') && accumulated.includes('id = "doc"'), "both writes accumulate");

    const advanced = core.openWorkspace(root);
    setBody(advanced, "alpha", D18_BODY.replace("Scope prose.", "Scope prose moved."));
    advanced.close();
    const stale = await call(
      "docs_record_add",
      { doc: "alpha", id: "REQ-3", type: "requirement", body: "Third.", section: "scope" },
      root,
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.error.kind, "checkout-conflict");
    assert.equal(readFileSync(candidateFile(root), "utf8"), accumulated, "the stale candidate is unchanged");
    const overwritten = await call(
      "docs_record_add",
      { doc: "alpha", id: "REQ-3", type: "requirement", body: "Third.", section: "scope", overwrite: true },
      root,
    );
    assert.equal(overwritten.ok, true, JSON.stringify(overwritten.error ?? {}));
    assert.ok(!readFileSync(candidateFile(root), "utf8").includes("Manual note."), "overwrite discards old bytes");
  });

  await check("AC-70", "a structured candidate cannot be imported after a change or a revision move", async () => {
    const changedRoot = d18Root("ac70-changed");
    const added = await call(
      "docs_record_add",
      { doc: "alpha", id: "REQ-2", type: "requirement", body: "Second.", section: "scope" },
      changedRoot,
    );
    assert.equal(added.ok, true, JSON.stringify(added.error ?? {}));
    writeFileSync(candidateFile(changedRoot), `${readFileSync(candidateFile(changedRoot), "utf8")}\nChanged.\n`);
    const rejected = await call(
      "docs_import",
      { path: ".pi/workspace-docs/checkout/alpha.md", token: added.token },
      changedRoot,
    );
    assert.equal(rejected.ok, true);
    assert.equal(rejected.status, "rejected");
    assert.ok(
      rejected.diagnostics.some((diagnostic) => diagnostic.code === "candidate-changed"),
      "the changed candidate is rejected",
    );

    const movedRoot = d18Root("ac70-moved");
    const added2 = await call(
      "docs_record_add",
      { doc: "alpha", id: "REQ-2", type: "requirement", body: "Second.", section: "scope" },
      movedRoot,
    );
    assert.equal(added2.ok, true, JSON.stringify(added2.error ?? {}));
    const advanced = core.openWorkspace(movedRoot);
    setBody(advanced, "alpha", D18_BODY.replace("Scope prose.", "Scope prose moved."));
    advanced.close();
    const staleImport = await call(
      "docs_import",
      { path: ".pi/workspace-docs/checkout/alpha.md", token: added2.token },
      movedRoot,
    );
    assert.equal(staleImport.ok, true);
    assert.equal(staleImport.status, "rejected");
    assert.ok(
      staleImport.diagnostics.some((diagnostic) => diagnostic.code === "revision"),
      "the moved revision is rejected",
    );
  });
} finally {
  for (const result of results) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"} ${result.ac} ${result.name}${result.ok ? "" : ` — ${result.reason}`}`,
    );
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} tool boundary checks passed`);
  rmSync(scratch, { recursive: true, force: true });
  if (failed.length > 0) {
    console.log("FAIL: workspace-docs tool boundary checks");
    process.exitCode = 1;
  } else {
    console.log("PASS: workspace-docs tool boundary checks");
  }
}
