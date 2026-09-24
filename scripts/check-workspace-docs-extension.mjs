#!/usr/bin/env node
// Checks the publication guard in workspace-docs.ts (D-12, REQ-EDIT-3).
//
// The extension is copied into a temporary directory beside a node_modules
// symlink to the installed Pi package, because the repo's own node_modules does
// not contain the Pi package, so the extension's bare import cannot resolve in
// place. The copy is byte-identical, and nothing here executes the extension
// against a live session or writes into a real workspace.
//
// Requires Node with TypeScript type stripping (Node >= 22.18 or 23); Node 24
// needs no flag. Pass the Pi package directory as argv[2] to override.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const scratch = mkdtempSync(join(tmpdir(), "pi-workspace-docs-ext-"));
const results = [];

async function check(ac, name, fn) {
  try {
    await fn();
    results.push({ ac, name, ok: true, reason: "" });
  } catch (error) {
    results.push({ ac, name, ok: false, reason: error?.message ?? String(error) });
  }
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

  const workspaceDocs = (await import(pathToFileURL(extensionPath).href)).default;
  const handlers = new Map();
  workspaceDocs({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: () => {},
    registerCommand: () => {},
  });
  const toolCall = handlers.get("tool_call");

  const cwd = join(scratch, "workspace");
  mkdirSync(join(cwd, ".pi", "workspace-docs", "out"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "workspace-docs", "checkout"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "workspace-docs", "publication.json"),
    JSON.stringify({
      version: 1,
      files: { "docs/spec.md": { hash: "abc", documentId: "spec" } },
      pending: {},
    }),
  );

  const invoke = (toolName, path) =>
    toolCall({ toolName, toolCallId: "call-1", input: { path } }, { cwd });

  await check("AC-26", "the extension registers the publication guard", () => {
    assert.equal(typeof toolCall, "function", "a tool_call handler is registered");
  });

  await check("AC-26", "built-in writes to generated artifacts are blocked", async () => {
    for (const target of [
      ".pi/workspace-docs/out/alpha.md",
      join(cwd, ".pi/workspace-docs/out/alpha.md"),
      ".pi/workspace-docs/index.md",
      ".pi/workspace-docs/store.sqlite",
      ".pi/workspace-docs/publication.json",
    ]) {
      const result = await invoke("write", target);
      assert.equal(result?.block, true, `blocked: ${target}`);
      assert.match(result.reason, /checkout/, `names the authoring workflow: ${target}`);
    }
    const edited = await invoke("edit", ".pi/workspace-docs/out/alpha.md");
    assert.equal(edited?.block, true, "edit is blocked too");
  });

  await check("AC-26", "recorded external outputs are blocked", async () => {
    const result = await invoke("write", "docs/spec.md");
    assert.equal(result?.block, true, "a recorded output outside .pi is blocked");
    assert.equal(
      (await invoke("write", join(cwd, "docs", "spec.md")))?.block,
      true,
      "an absolute recorded output is blocked",
    );
  });

  await check("AC-26", "authoring candidates and ordinary files are not blocked", async () => {
    for (const target of [
      ".pi/workspace-docs/checkout/alpha.md",
      join(cwd, ".pi", "workspace-docs", "checkout", "alpha.md"),
      "src/index.ts",
      join(cwd, "README.md"),
      "../outside.md",
      "/tmp/elsewhere.md",
    ]) {
      assert.equal(await invoke("write", target), undefined, `allowed: ${target}`);
    }
    assert.equal(await invoke("bash", ".pi/workspace-docs/out/alpha.md"), undefined, "other tools are untouched");
    assert.equal(await invoke("write", ""), undefined, "an empty path is ignored");
  });
} finally {
  for (const result of results) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"} ${result.ac} ${result.name}${result.ok ? "" : ` — ${result.reason}`}`,
    );
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} extension checks passed`);
  rmSync(scratch, { recursive: true, force: true });
  if (failed.length > 0) {
    console.log("FAIL: workspace-docs extension checks");
    process.exitCode = 1;
  } else {
    console.log("PASS: workspace-docs extension checks");
  }
}
