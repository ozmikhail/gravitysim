import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { context } from "@ozlabs/plumb";
import { check } from "../index.mjs";

const config = (files) => JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx" }, files });
function fixture(t, files, projects = [{ root: ".", profile: "typescript" }]) {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-adapter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entries = { "plumb.json": JSON.stringify({ schemaVersion: 1, preset: "portable", projects }), "tsconfig.json": config(["entry.ts"]), ...files };
  for (const [path, content] of Object.entries(entries)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return context({ root });
}

test("actual adapter distinguishes type violations from missing compiler inputs", async (t) => {
  const valid = await check(fixture(t, { "entry.ts": "export const answer: number = 1;\n" }));
  assert.ok(!valid.diagnostics.some((item) => item.status === "incomplete"), JSON.stringify(valid.diagnostics));
  assert.ok(!valid.diagnostics.some((item) => item.rule === "javascript/types"), JSON.stringify(valid.diagnostics));
  const invalid = await check(fixture(t, { "entry.ts": 'export const answer: number = "wrong";\n' }));
  const typeError = invalid.diagnostics.find((item) => item.rule === "javascript/types" && item.message.startsWith("TS2322:"));
  assert.ok(typeError, JSON.stringify(invalid.diagnostics));
  assert.notEqual(typeError.status, "incomplete");
  const missing = await check(fixture(t, { "entry.ts": 'import { value } from "./missing";\nexport const answer = value;\n' }));
  const unavailable = missing.diagnostics.find((item) => item.rule === "javascript/types" && item.message.startsWith("TS2307:"));
  assert.ok(unavailable, JSON.stringify(missing.diagnostics));
  assert.equal(unavailable.status, "incomplete");
  assert.equal(unavailable.suppressible, false);
});

test("actual adapter lints a one-character nested project only under its owner", async (t) => {
  const ctx = fixture(t, {
    "entry.ts": "export const answer = 1;\n",
    "a/entry.tsx": "debugger;\nexport {};\n",
    "a/tsconfig.json": config(["entry.tsx"]),
  }, [{ root: ".", profile: "typescript" }, { root: "a", profile: "react" }]);
  const checked = await check(ctx);
  assert.ok(!checked.diagnostics.some((item) => item.status === "incomplete"), JSON.stringify(checked.diagnostics));
  const findings = checked.diagnostics.filter((item) => item.rule === "javascript/no-debugger" && item.path === "a/entry.tsx");
  assert.equal(findings.length, 1, JSON.stringify(checked.diagnostics));
});
