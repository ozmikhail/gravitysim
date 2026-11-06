import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "../src/cli.mjs";
import { checkRepository, context, scaffoldRepository } from "../src/engine.mjs";
import { scaffold } from "../src/scaffold.mjs";

const policy = () => ({ schemaVersion: 1, preset: "portable", conventions: { files: ["src/**", "test/**"], roles: [
  { id: "source", files: ["src/**"], name: "^[a-z-]+\\.txt$", companions: [{ path: "test/{stem}.txt", role: "test" }], scaffold: { path: "src/{name}.txt", content: "source {name}\n", companions: [{ path: "test/{name}.txt", content: "test {name}\n" }] } },
  { id: "test", files: ["test/**"] },
] } });
function fixture(t, value = policy()) {
  const temporary = process.env.PLUMB_TEST_TMP ?? tmpdir(); mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, "scaffold-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "plumb.json"), JSON.stringify(value)); return root;
}
const check = (candidate) => checkRepository(candidate);
const pass = () => ({ status: "pass", exitCode: 0, checks: [], diagnostics: [] });

test("scaffolding validates the complete new role and companions in isolation before writing", async (t) => {
  const root = fixture(t);
  const preview = await scaffoldRepository({ root, role: "source", name: "greeting", dryRun: true });
  assert.equal(preview.exitCode, 0, JSON.stringify(preview.diagnostics));
  assert.equal(preview.plan.kind, "plumb-scaffold");
  assert.equal(existsSync(join(root, "src/greeting.txt")), false);
  assert.deepEqual(preview.plan.files.map((item) => item.path), ["src/greeting.txt", "test/greeting.txt"]);
  assert.match(preview.plan.identity.snapshot, /^[a-f0-9]{64}$/);
  assert.ok(preview.plan.patch.startsWith('--- /dev/null\n+++ "b/src/greeting.txt"\n@@ -0,0 +1,'), preview.plan.patch);
  const created = await scaffoldRepository({ root, role: "source", name: "greeting" });
  assert.equal(created.exitCode, 0, JSON.stringify(created.diagnostics));
  assert.deepEqual(created.written, ["src/greeting.txt", "test/greeting.txt"]);
  assert.equal(readFileSync(join(root, "src/greeting.txt"), "utf8"), "source greeting\n");
  assert.equal((await checkRepository({ root })).exitCode, 0);
  const again = await scaffoldRepository({ root, role: "source", name: "greeting" });
  assert.equal(again.exitCode, 2); assert.equal(again.written.length, 0);
});

test("invalid or incomplete scaffold validation never creates original source", async (t) => {
  const value = policy(); value.files = { names: [{ files: ["src/**"], pattern: "^approved\\.txt$", reason: "approved names" }] };
  const root = fixture(t, value), refused = await scaffoldRepository({ root, role: "source", name: "bad" });
  assert.equal(refused.exitCode, 1); assert.ok(refused.diagnostics.some((item) => item.rule === "files.names"));
  assert.equal(refused.written.length, 0); assert.equal(existsSync(join(root, "src")), false);
  const ctx = context({ root: fixture(t) });
  const incomplete = await scaffold(ctx, async () => ({ status: "incomplete", exitCode: 2, checks: [], diagnostics: [{ rule: "tools.missing", path: ".", status: "incomplete" }] }), { role: "source", name: "new" });
  assert.equal(incomplete.written.length, 0); assert.equal(incomplete.plan.validation.status, "incomplete");
  assert.equal(existsSync(join(ctx.root, "src")), false);
  for (const status of ["violation", "incomplete", "unknown"]) {
    await assert.rejects(scaffold(ctx, async () => ({ ...pass(), checks: [{ id: "required", status }] }), { role: "source", name: "new" }), /contradicts/);
    assert.equal(existsSync(join(ctx.root, "src")), false);
  }
});

test("a checker cannot mutate scaffold proposals or approve stale original inputs", async (t) => {
  const root = fixture(t), ctx = context({ root });
  await assert.rejects(scaffold(ctx, async (candidate) => { writeFileSync(join(candidate.root, "src/new.txt"), "changed"); return pass(); }, { role: "source", name: "new" }), /checker changed/);
  assert.equal(existsSync(join(root, "src")), false);
  await assert.rejects(scaffold(ctx, async () => { writeFileSync(join(root, "other.txt"), "concurrent"); return pass(); }, { role: "source", name: "new" }), /inputs changed/);
  assert.equal(existsSync(join(root, "src")), false);
  assert.equal(readFileSync(join(root, "other.txt"), "utf8"), "concurrent");
});

test("multi-file creation rolls back its own files when a later exclusive open fails", async (t) => {
  const root = fixture(t); let count = 0;
  await assert.rejects(scaffold(context({ root }), check, { role: "source", name: "new", create: (...args) => {
    if (++count === 2) throw new Error("simulated create failure");
    return openSync(...args);
  } }), /simulated create failure/);
  assert.equal(existsSync(join(root, "src")), false); assert.equal(existsSync(join(root, "test")), false);
});

test("rollback preserves a path created by another writer", async (t) => {
  const root = fixture(t); let count = 0;
  await assert.rejects(scaffold(context({ root }), check, { role: "source", name: "new", create: (...args) => {
    if (++count === 2) writeFileSync(args[0], "concurrent");
    return openSync(...args);
  } }), /EEXIST/);
  assert.equal(existsSync(join(root, "src/new.txt")), false);
  assert.equal(readFileSync(join(root, "test/new.txt"), "utf8"), "concurrent");
});

test("CLI scaffold enforces its arguments and reports the reviewable proposal", async (t) => {
  const root = fixture(t); let output = "";
  assert.equal(await main(["scaffold", "source", "hello", "--root", root, "--dry-run", "--format", "json"], (text) => { output += text; }), 0);
  assert.equal(JSON.parse(output).plan.files.length, 2);
  assert.equal(existsSync(join(root, "src")), false);
  for (const args of [["scaffold", "source"], ["scaffold", "source", "hello", "--apply", "x"], ["scaffold", "source", "hello", "--staged"]]) {
    assert.equal(await main([...args, "--root", root], () => {}), 2);
  }
});
