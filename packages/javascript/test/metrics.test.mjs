import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkMetrics } from "../src/metrics.mjs";

function fixture(t, files, budgets) {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-metrics-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); }
  return { root, files: Object.keys(files), config: { preset: "portable", projects: [], conventions: { files: ["src/**"], roles: [{ id: "implementation", files: ["src/**"], javascript: { budgets } }] } } };
}

test("implementation budgets count physical body lines, parameters and function-local nesting", (t) => {
  const context = fixture(t, { "src/a.ts": "export function outer(a: boolean, b: boolean) {\n  if (a) {\n    while (b) { break; }\n  }\n  function inner() { if (a) { if (b) { return; } } }\n}\n" }, { functionLines: 5, maxParameters: 1, maxNesting: 1 });
  const result = checkMetrics(context);
  assert.equal(result.filter((item) => item.message.includes("functionLines is 6")).length, 1);
  assert.equal(result.filter((item) => item.message.includes("maxParameters is 2")).length, 1);
  assert.equal(result.filter((item) => item.message.includes("maxNesting is 2")).length, 2);
  assert.ok(result.every((item) => item.rule === "conventions.budget"));
});

test("duplication ignores trivia but retains identifier and literal spelling", (t) => {
  const context = fixture(t, {
    "src/a.ts": "export function first() { const value = 1; return value; }",
    "src/b.ts": "export function second() {\n/** different documentation */ const value=1;\nreturn value;\n}",
    "src/c.ts": "export function third() { const different = 1; return different; }",
    "src/d.ts": "export function fourth() { const value = 2; return value; }",
  }, { duplicateBlocks: { minStatements: 2, maxCopies: 1 } });
  const result = checkMetrics(context);
  assert.equal(result.length, 1, JSON.stringify(result));
  assert.equal(result[0].rule, "conventions.duplication");
  assert.deepEqual(result[0].relatedLocations.map((item) => item.path), ["src/a.ts", "src/b.ts"]);
});

test("regex and template literal contents remain distinct in duplication fingerprints", (t) => {
  const context = fixture(t, {
    "src/a.ts": "export function a() { const value = /foo/; return `one ${value}`; }",
    "src/b.ts": "export function b() { const value = /bar/; return `one ${value}`; }",
    "src/c.ts": "export function c() { const value = /foo/; return `two ${value}`; }",
  }, { duplicateBlocks: { minStatements: 2, maxCopies: 1 } });
  assert.deepEqual(checkMetrics(context), []);
});

test("a role's duplication count never combines unrelated roles", (t) => {
  const context = fixture(t, { "src/a.ts": "function a() { const x = 1; return x; }", "src/b.ts": "function b() { const x = 1; return x; }" }, { duplicateBlocks: { minStatements: 2, maxCopies: 1 } });
  context.config.conventions.roles[0].files = ["src/a.ts"];
  context.config.conventions.roles.push({ ...context.config.conventions.roles[0], id: "other", files: ["src/b.ts"] });
  assert.deepEqual(checkMetrics(context), []);
});

test("unsupported language and parse failures cannot satisfy a budget check", (t) => {
  const context = fixture(t, { "src/a.txt": "text", "src/b.ts": "function broken( {" }, { maxParameters: 1 });
  const result = checkMetrics(context);
  assert.equal(result.length, 2); assert.ok(result.every((item) => item.status === "incomplete" && item.suppressible === false));
});
