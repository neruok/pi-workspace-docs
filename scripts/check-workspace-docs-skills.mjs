#!/usr/bin/env node
// Acceptance checks for the standalone workspace-docs skills (AC-14, AC-15).
//
// Criteria come from docs/workspace-documentation-spec.md section 7 in the
// new-coder profile's documentation store. The skills are prose, so these
// checks inspect their content and exercise the core once without loading any
// skill. Runs with plain Node, without Pi and without a model.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("../", import.meta.url));
const skillsDir = join(repoDir, "skills");
const core = await import(new URL("../lib/workspace-docs/index.ts", import.meta.url));

/** The D-14 and D-18 tool surface. `scripts/check-workspace-docs-tools.mjs` checks these. */
const EXTENSION_TOOLS = [
  "docs_discover",
  "docs_read",
  "docs_checkout",
  "docs_preview_import",
  "docs_import",
  "docs_create",
  "docs_validate",
  "docs_references",
  "docs_terms",
  "docs_compile",
  "docs_record_add",
  "docs_record_update",
  "docs_record_delete",
  "docs_term_add",
  "docs_term_update",
  "docs_term_delete",
  "docs_link_add",
  "docs_link_remove",
  "docs_section_add",
  "docs_section_move",
  "docs_section_setBody",
  "docs_prose_insert",
];

const AUTHORING = "workspace-docs-authoring";
const REVIEW = "workspace-docs-review";
const CRITICAL = "workspace-docs-critical-coding";

const results = [];

function check(ac, name, fn) {
  try {
    fn();
    results.push({ ac, name, ok: true, reason: "" });
  } catch (error) {
    results.push({ ac, name, ok: false, reason: error?.message ?? String(error) });
  }
}

/** Read a skill and its frontmatter metadata. */
function skill(name) {
  const path = join(skillsDir, name, "SKILL.md");
  const text = readFileSync(path, "utf8");
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(front, `${name}: missing frontmatter`);
  const meta = Object.fromEntries(
    [...front[1].matchAll(/^([a-z-]+):\s*(.+)$/gm)].map((match) => [match[1], match[2].trim()]),
  );
  const body = text.slice(front[0].length);
  return { text, meta, body };
}

function toolsReferenced(text) {
  return new Set([...text.matchAll(/\bdocs_[A-Za-z0-9_]+/g)].map((match) => match[0]));
}

const scratch = mkdtempSync(join(tmpdir(), "pi-workspace-docs-skills-"));
try {
  await check("AC-14", "the extension core works without loading a skill", () => {
    const ws = core.openWorkspace(join(scratch, "no-skills"));
    ws.createDocument({ id: "alpha", title: "Alpha", type: "specification" });
    const candidate = `${ws.checkout("alpha").text.trimEnd()}\n\n\`\`\`docs-record\nid = "REQ-1"\ntype = "requirement"\n\nIt MUST work.\n\`\`\`\n`;
    const preview = ws.previewImport(candidate);
    assert.equal(ws.importCandidate(candidate, preview.token).status, "committed");
    assert.ok(ws.validate().every((diagnostic) => diagnostic.severity !== "block"));
    ws.close();
  });

  check("AC-14", "standalone authoring and review skills exist with frontmatter", () => {
    const authoring = skill(AUTHORING);
    const review = skill(REVIEW);
    assert.equal(authoring.meta.name, AUTHORING);
    assert.equal(review.meta.name, REVIEW);
    assert.ok(authoring.meta.description.length > 0, "authoring skill has a description");
    assert.ok(review.meta.description.length > 0, "review skill has a description");
    assert.ok(/checkout/i.test(authoring.body), "authoring guidance names checkout");
    assert.ok(/review/i.test(review.body), "review guidance is about review");
  });

  check("AC-14", "the bundled companion skills exist with matching names", () => {
    for (const name of ["workspace-docs-specifications", "workspace-docs-prose", CRITICAL]) {
      assert.equal(skill(name).meta.name, name, `${name}: frontmatter name matches the directory`);
    }
  });

  check("AC-14", "the skills use the extension tools and establish no second store", () => {
    const authoring = skill(AUTHORING);
    const review = skill(REVIEW);
    for (const [name, contents] of [
      [AUTHORING, authoring.body],
      [REVIEW, review.body],
      [CRITICAL, skill(CRITICAL).body],
    ]) {
      for (const tool of toolsReferenced(contents)) {
        assert.ok(EXTENSION_TOOLS.includes(tool), `${name}: unknown tool ${tool}`);
      }
      assert.match(contents, /\.pi\/workspace-docs\//, `${name}: names the extension store directory`);
      assert.ok(!/store\.(json|sqlite)|\.db\b/.test(contents.replace(/store\.sqlite/gi, "")), `${name}: no competing store`);
    }
    for (const tool of ["docs_checkout", "docs_preview_import", "docs_import"]) {
      assert.ok(toolsReferenced(authoring.body).has(tool), `authoring guidance names ${tool}`);
    }
    assert.ok(toolsReferenced(review.body).has("docs_validate"), "review guidance names docs_validate");
    // The scan must recognize camelCase tool names; otherwise the unknown-tool
    // guard above silently skips them. Regression: docs_section_setBody.
    assert.ok(
      toolsReferenced(authoring.body).has("docs_section_setBody"),
      "the tool scan recognizes camelCase tool names",
    );
  });

  check("AC-15", "authoring guidance exposes unresolved choices instead of inventing policy", () => {
    const { body } = skill(AUTHORING);
    assert.match(body, /unresolved/i, "authoring guidance names unresolved choices");
    assert.match(body, /(do not|must not|never) invent/i, "authoring guidance forbids inventing policy");
    assert.match(body, /proposed/i, "authoring guidance keeps proposed content distinct");
    assert.match(body, /normative/i, "authoring guidance separates normative content");
    assert.match(body, /rationale/i, "authoring guidance separates rationale");
    assert.match(body, /docs-delete/, "authoring guidance uses explicit deletion");
    assert.match(body, /approved-users/, "authoring guidance names the approver list field");
  });

  check("AC-15", "review guidance separates structural validation from semantic correctness", () => {
    const { body, meta } = skill(REVIEW);
    assert.match(body, /structural/i, "review guidance names structural checks");
    assert.match(body, /semantic/i, "review guidance names semantic judgment");
    assert.match(
      body,
      /(not|never)[^.]{0,80}(proof|correct|complete)/i,
      "review guidance denies that a clean validation proves correctness",
    );
    assert.match(body, /unresolved/i, "review guidance keeps unresolved policy visible");
    assert.match(meta.description, /review/i);
  });
} finally {
  for (const result of results) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"} ${result.ac} ${result.name}${result.ok ? "" : ` — ${result.reason}`}`,
    );
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} skill checks passed`);
  rmSync(scratch, { recursive: true, force: true });
  if (failed.length > 0) {
    console.log("FAIL: workspace-docs skill checks");
    process.exitCode = 1;
  } else {
    console.log("PASS: workspace-docs skill checks");
  }
}
