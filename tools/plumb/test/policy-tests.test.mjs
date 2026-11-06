import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { definePlumb } from "../src/config.mjs";
import { checkRepository, context, testPolicy } from "../src/engine.mjs";
import { main } from "../src/cli.mjs";
import { runPolicyTests } from "../src/policy-tests.mjs";

const group = () => ({ id: "naming", files: [{ path: "src/good.txt", content: "one\n" }], cases: [
  { id: "bad-name", edits: [{ path: "src/Bad.txt", content: "one\n" }], expect: { status: "violation", diagnostics: [{ rule: "files.names", path: "src/Bad.txt" }] } },
  { id: "equivalent-content", edits: [{ path: "src/good.txt", content: "two\n" }], expect: { status: "pass" } },
] });
const policy = () => ({ schemaVersion: 1, preset: "portable", files: { names: [{ files: ["src/**"], pattern: "^[a-z]+\\.txt$", reason: "lowercase names" }] }, policyTests: [group()] });
function fixture(t, value = policy()) {
  const temporary = process.env.PLUMB_TEST_TMP ?? tmpdir(); mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, "policy-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src/good.txt"), "original\n");
  writeFileSync(join(root, "plumb.json"), JSON.stringify(value)); return root;
}

test("actual checker policy tests accept baseline, intended violation and equivalent rewrites", async (t) => {
  const root = fixture(t), result = await testPolicy({ root });
  assert.equal(result.exitCode, 0, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.policyTests[0].cases.map((item) => item.actual), ["pass", "violation", "pass"]);
  assert.ok(result.policyTests[0].cases.every((item) => /^[a-f0-9]{64}$/.test(item.snapshot)));
  assert.equal(readFileSync(join(root, "src/good.txt"), "utf8"), "original\n");
  const complete = await checkRepository({ root });
  assert.equal(complete.exitCode, 0, JSON.stringify(complete.diagnostics));
  assert.equal(complete.checks.find((item) => item.id === "policy-test:naming").status, "pass");
});

test("a passing mutation, wrong diagnostic, extra diagnostic or wrong count cannot prove enforcement", async (t) => {
  for (const edit of [
    (value) => { value.policyTests[0].cases[0].edits[0].path = "src/valid.txt"; },
    (value) => { value.policyTests[0].cases[0].expect.diagnostics[0].rule = "files.required"; },
    (value) => { value.policyTests[0].cases[0].expect.diagnostics[0].count = 2; },
    (value) => { value.policyTests[0].cases[0].edits.push({ path: "src/Other.txt", content: "other" }); },
  ]) {
    const value = policy(); edit(value); const result = await testPolicy({ root: fixture(t, value) });
    assert.equal(result.exitCode, 1, JSON.stringify(result.diagnostics));
    assert.ok(result.diagnostics.some((item) => item.rule === "policy-tests.failed" && item.suppressible === false));
  }
});

test("the baseline must pass and missing tools or unreadable fixture inputs stay incomplete", async (t) => {
  const value = policy(); value.policyTests[0].files[0].path = "src/Bad.txt";
  const baseline = await testPolicy({ root: fixture(t, value) });
  assert.equal(baseline.exitCode, 2); assert.match(baseline.diagnostics[0].message, /baseline/);
  const ctx = context({ root: fixture(t) });
  const result = await runPolicyTests(ctx, async () => ({ status: "incomplete", exitCode: 2, checks: [], diagnostics: [{ rule: "tools.missing", path: ".", status: "incomplete" }] }));
  assert.equal(result.checks[0].status, "incomplete");
  for (const status of ["incomplete", "violation", "unknown"]) {
    const contradictory = await runPolicyTests(ctx, async () => ({ status: "pass", exitCode: 0, checks: [{ id: "required", status }], diagnostics: [] }));
    assert.equal(contradictory.checks[0].status, "incomplete");
  }
});

test("policy fixture execution rejects source mutation and starts every case from clean data", async (t) => {
  const ctx = context({ root: fixture(t) });
  const result = await runPolicyTests(ctx, async ({ root }) => {
    writeFileSync(join(root, "src/good.txt"), "mutated by checker");
    return { status: "pass", exitCode: 0, checks: [], diagnostics: [] };
  });
  assert.equal(result.checks[0].status, "incomplete"); assert.match(result.diagnostics[0].message, /changed its fixture/);
  const value = policy(); value.policyTests[0].cases = [
    { id: "delete", edits: [{ path: "src/good.txt", delete: true }], expect: { status: "violation", diagnostics: [{ rule: "files.scope" }] } },
    { id: "fresh", edits: [{ path: "src/good.txt", content: "fresh" }], expect: { status: "pass" } },
  ];
  const checked = await testPolicy({ root: fixture(t, value) });
  assert.equal(checked.policyTests[0].cases.find((item) => item.id === "fresh").status, "pass");
});

test("fixture policy shape refuses ambiguity, overwritten policy and overlapping expectations", () => {
  for (const edit of [
    (value) => { value.policyTests[0].cases[0].id = "baseline"; },
    (value) => { value.policyTests.push(group()); },
    (value) => { value.policyTests[0].files[0].path = "../escape"; },
    (value) => { value.policyTests[0].files[0].path = "plumb.json"; },
    (value) => { value.policyTests[0].cases[0].edits[0].delete = true; },
    (value) => { value.policyTests[0].cases[0].expect.diagnostics.push({ rule: "files.names" }); },
    (value) => { value.policyTests[0].cases[1].expect.diagnostics = [{ rule: "files.names" }]; },
    (value) => { delete value.policyTests[0].cases[0].expect.diagnostics; },
  ]) { const value = policy(); edit(value); assert.throws(() => definePlumb(value)); }
});

test("CLI runs declared policy acceptance tests and refuses an empty test selection", async (t) => {
  let text = "";
  assert.equal(await main(["policy-test", "--root", fixture(t), "--format", "json"], (chunk) => { text += chunk; }), 0);
  assert.equal(JSON.parse(text).command, "policy-test");
  assert.equal((await testPolicy({ root: fixture(t, { schemaVersion: 1, preset: "portable" }) })).exitCode, 2);
});

test("fixtures preserve source policy bytes and normalize custom policy paths before guarding edits", async (t) => {
  const root = fixture(t), formatted = `${JSON.stringify(policy(), null, 2)}\n`;
  writeFileSync(join(root, "custom.json"), formatted);
  const ctx = context({ root, configFile: "./custom.json" });
  assert.equal(ctx.configFile, "custom.json");
  let observed = false;
  await runPolicyTests(ctx, async (candidate) => {
    assert.equal(readFileSync(join(candidate.root, "custom.json"), "utf8"), formatted); observed = true;
    return checkRepository(candidate);
  });
  assert.equal(observed, true);
  const value = policy(); value.policyTests[0].cases[0].edits = [{ path: "custom.json", content: "{}" }];
  writeFileSync(join(root, "custom.json"), JSON.stringify(value));
  await assert.rejects(runPolicyTests(context({ root, configFile: "./custom.json" }), async () => { throw new Error("must not execute"); }), /policy-replacing/);
});
