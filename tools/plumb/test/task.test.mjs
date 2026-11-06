import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyExceptions } from "../src/policy.mjs";
import { checkTask, defineTask, loadTask, RULES } from "../src/task.mjs";

const subject = "b".repeat(64);
const task = (data = {}) => defineTask({ schemaVersion: 1, id: "payments-fix", ...data });
const run = (value, options = {}) => checkTask(value, options);
const receipt = (extra = {}) => ({ id: "payments", status: "pass", tests: 2, passed: 2, failed: 0, skipped: 0, subject, reportSha256: "c".repeat(64), ...extra });

test("task configuration is strict and immutable", () => {
  for (const data of [
    { preset: "portable" }, { exceptions: [] }, { files: {} }, { files: { allow: [] } },
    { files: { allow: ["../**"] } }, { dependencies: "allow" }, { dependencyFiles: ["**/custom.json"] },
    { changes: [{ id: "empty", when: ["src/**"], reason: "no effect" }] },
    { changes: [1, 2].map(() => ({ id: "duplicate", when: ["src/**"], reason: "test", requireTests: ["payments"] })) },
  ]) assert.throws(() => task(data));
  const value = task({ requireChecks: ["files"] });
  assert.ok(Object.isFrozen(value.requireChecks));
  assert.throws(() => value.requireChecks.push("types"));
});

test("required check capabilities cover every matching scope, including incomplete and missing scopes", () => {
  const value = task({ requireChecks: ["types"] });
  const a = { id: "types:api", capability: "types", status: "pass" };
  assert.deepEqual(run(value, { checks: [a, { id: "types:web", capabilities: ["types"], status: "pass" }] }).diagnostics, []);
  for (const checks of [[], [{ ...a, status: "not-applicable" }], [a, { ...a, id: "types:web", status: "incomplete" }]]) {
    assert.equal(run(value, { checks }).diagnostics[0].status, "incomplete");
  }
  assert.equal(run(value, { checks: [{ ...a, status: "violation" }] }).diagnostics[0].status, "violation");
});

test("required tests need complete, nonempty evidence from the same subject", () => {
  const value = task({ requireTests: ["payments"] });
  assert.deepEqual(run(value, { testResults: [receipt()], subject }).diagnostics, []);
  for (const testResults of [
    [], [receipt({ tests: 0, passed: 0 })], [receipt({ tests: 2, passed: 0, skipped: 2 })],
    [receipt({ passed: 1 })], [receipt({ status: "incomplete" })], [receipt({ status: "not-applicable" })],
    [receipt({ subject: "old-subject" })], [receipt(), receipt()], [receipt({ tests: 1.5, passed: 1.5 })],
    [receipt({ passed: 1, failed: 1 })],
  ]) {
    const result = run(value, { testResults, subject });
    assert.equal(result.diagnostics[0].status, "incomplete", JSON.stringify(testResults));
  }
  assert.equal(run(value, { testResults: [receipt({ status: "violation", passed: 1, failed: 1 })], subject }).diagnostics[0].status, "violation");
});

test("task restrictions cannot be suppressed by project exceptions", () => {
  const result = run(task({ requireChecks: ["types"] }));
  const applied = applyExceptions(result.diagnostics, [{ id: "bypass", rules: ["task.checks"], files: ["**"], reason: "waive assignment", max: 1 }], RULES);
  assert.equal(applied.suppressed.length, 0);
  assert.ok(applied.diagnostics.some((item) => item.rule === "exceptions.invalid"));
});

test("approved task files are external, regular, fingerprinted and mutation-checked", (t) => {
  const temporary = process.env.PLUMB_TEST_TMP ?? fileURLToPath(new URL("../../.plumb-tests", import.meta.url));
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, "task-")), root = join(directory, "candidate"), file = join(directory, "task.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(root);
  writeFileSync(file, JSON.stringify(task()));
  const loaded = loadTask(file, { root });
  assert.match(loaded.identity.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(run(loaded).diagnostics, []);
  writeFileSync(join(root, "task.json"), readFileSync(file));
  assert.throws(() => loadTask(join(root, "task.json"), { root }), /outside the candidate/);
  symlinkSync(file, join(directory, "task-link.json"));
  assert.throws(() => loadTask(join(directory, "task-link.json"), { root }), /Symbolic links/);
  writeFileSync(file, JSON.stringify(task({ requireTests: ["payments"] })));
  assert.ok(run(loaded).diagnostics.some((item) => item.rule === "task.changed" && item.status === "incomplete"));
});
