import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { safePath } from "../src/files.mjs";
import { parseVerification, verifySuites } from "../src/verification.mjs";

test("JUnit execution counts require distinct case identities", () => {
  const repeated = '<testsuite name="unit" tests="2"><testcase name="behavior"/><testcase name="behavior"/></testsuite>';
  assert.throws(() => parseVerification(repeated, "junit", "unit"), /duplicate|identity/i);
});

test("behavioral verification refuses new unsafe files in its isolated copy", { skip: process.platform === "win32" }, async (t) => {
  const parent = process.env.PLUMB_TEST_TMP ?? tmpdir(); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "plumb-verification-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source.txt"), "source\n");
  const source = `import {symlinkSync} from 'node:fs'; symlinkSync('source.txt', 'new-link.txt'); process.stdout.write(JSON.stringify({schemaVersion:1,suite:'unit',tests:[{id:'behavior',status:'passed'}]}));`;
  const ctx = { root, allFiles: ["source.txt"], safePath: (path, options) => safePath(root, path, options), config: { verification: [{ id: "unit", command: [process.execPath, "--input-type=module", "-e", source], format: "plumb-json" }] } };
  const result = await verifySuites(ctx);
  assert.equal(result.results[0].status, "incomplete", JSON.stringify(result));
  assert.ok(result.diagnostics.some((item) => item.rule === "verification.incomplete"));
  assert.equal(existsSync(join(root, "new-link.txt")), false);
});

test("a fresh report path cannot point through a symlink to stale evidence", { skip: process.platform === "win32" }, async (t) => {
  const parent = process.env.PLUMB_TEST_TMP ?? tmpdir(); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "plumb-verification-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "old-report.json"), JSON.stringify({ schemaVersion: 1, suite: "unit", tests: [{ id: "old-behavior", status: "passed" }] }));
  const source = "import {symlinkSync} from 'node:fs'; import {resolve} from 'node:path'; symlinkSync(resolve('old-report.json'), process.env.PLUMB_REPORT);";
  const ctx = { root, allFiles: ["old-report.json"], safePath: (path, options) => safePath(root, path, options), config: { verification: [{ id: "unit", command: [process.execPath, "--input-type=module", "-e", source], format: "plumb-json", report: "file" }] } };
  const result = await verifySuites(ctx);
  assert.equal(result.results[0].status, "incomplete", JSON.stringify(result));
  assert.ok(result.diagnostics.some((item) => item.rule === "verification.incomplete"));
});
