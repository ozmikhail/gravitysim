import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { definePlumb } from "../src/config.mjs";
import { digest, inventory } from "../src/files.mjs";
import { isPolicyFile } from "../src/policy.mjs";
import { applyRepairs, previewRepairs, repairPatch } from "../src/repair.mjs";
import { inputDigest, loadInputs } from "../src/workspace.mjs";

const temporaryRoot = process.env.PLUMB_TEST_TMP ?? fileURLToPath(new URL("../../.plumb-tests", import.meta.url));
mkdirSync(temporaryRoot, { recursive: true });
const checker = { version: "test", sha256: digest("checker") };
function fixture(t, files = {}, options = {}) {
  const root = mkdtempSync(join(temporaryRoot, "repair-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = definePlumb({ schemaVersion: 1, preset: "portable", ...options });
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  write("plumb.json", JSON.stringify(config));
  for (const [path, content] of Object.entries(files)) write(path, content);
  const selected = inventory(root).files;
  const ctx = { root, path: join(root, "plumb.json"), configFile: "plumb.json", config, files: selected, allFiles: selected, writableFiles: selected.filter((path) => !isPolicyFile(config, path)), ownedFiles: (config.generated ?? []).map((item) => item.path), inputs: new Map() };
  return { ctx, root, write };
}
const change = (path, value) => async (root) => { writeFileSync(join(root, path), value); return { diagnostics: [] }; };
const preview = (ctx, callback, options = {}) => previewRepairs(ctx, callback, { temporaryRoot, checker, ...options });

test("repair preview changes an isolated copy and produces an applicable, source-bound patch", async (t) => {
  const { ctx, root } = fixture(t, { "source.txt": "first\nwrong\nlast\n" });
  let copied;
  const plan = await preview(ctx, async (isolated) => { copied = isolated; assert.notEqual(isolated, root); return change("source.txt", "first\nright\nlast\n")(isolated); });
  assert.equal(existsSync(copied), false);
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "first\nwrong\nlast\n");
  assert.equal(plan.kind, "plumb-repair"); assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].beforeSha256, digest("first\nwrong\nlast\n"));
  assert.equal(plan.changes[0].afterSha256, digest("first\nright\nlast\n"));
  assert.ok(plan.patch.startsWith('--- "a/source.txt"\n+++ "b/source.txt"\n@@ -1,3 +1,3 @@\n first\n-wrong\n+right\n last\n'), plan.patch);
  assert.deepEqual(applyRepairs(ctx, plan, { checker }).written, ["source.txt"]);
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "first\nright\nlast\n");
});

test("repair plans preserve BOM, newline and empty-file distinctions", async (t) => {
  const { ctx, root } = fixture(t, { "bom.txt": "\ufeffbefore\n", "no-newline.txt": "before", "empty.txt": "", 'quoted name".txt': "before\r\n" });
  const plan = await preview(ctx, async (isolated) => {
    for (const [path, content] of Object.entries({ "bom.txt": "\ufeffafter\n", "no-newline.txt": "after\n", "empty.txt": "line\n", 'quoted name".txt': "after\r\n" })) writeFileSync(join(isolated, path), content);
    return { diagnostics: [] };
  });
  assert.ok(plan.patch.includes("\\ No newline at end of file"));
  assert.ok(plan.patch.includes('--- "a/quoted name\\".txt"\n+++ "b/quoted name\\".txt"\n'), plan.patch);
  applyRepairs(ctx, plan, { checker });
  assert.deepEqual(readFileSync(join(root, "bom.txt")).subarray(0, 3), Buffer.from([239, 187, 191]));
  assert.equal(readFileSync(join(root, 'quoted name".txt'), "utf8"), "after\r\n");
});

test("every repair is preflighted before any source write", async (t) => {
  const { ctx, root, write } = fixture(t, { "one.txt": "one\n", "two.txt": "two\n" });
  const plan = await preview(ctx, async (isolated) => { writeFileSync(join(isolated, "one.txt"), "fixed one\n"); writeFileSync(join(isolated, "two.txt"), "fixed two\n"); return { diagnostics: [] }; });
  write("two.txt", "concurrent\n");
  assert.throws(() => applyRepairs(ctx, plan, { checker }), /Stale repair/);
  assert.equal(readFileSync(join(root, "one.txt"), "utf8"), "one\n");
  assert.equal(readFileSync(join(root, "two.txt"), "utf8"), "concurrent\n");
  assert.ok(!readdirSync(root).some((path) => path.startsWith(".plumb-")));
});

test("repair policy, checker, patch and content integrity cannot silently drift", async (t) => {
  const { ctx, root } = fixture(t, { "source.txt": "before\n" });
  const plan = await preview(ctx, change("source.txt", "after\n"));
  assert.throws(() => applyRepairs({ ...ctx, config: definePlumb({ ...ctx.config, files: { maxLines: 10 } }) }, plan, { checker }), /policy changed/);
  assert.throws(() => applyRepairs(ctx, plan), /checker changed/);
  assert.throws(() => applyRepairs(ctx, plan, { checker: { ...checker, sha256: digest("different") } }), /checker changed/);
  const modified = structuredClone(plan); modified.changes[0].after = "different\n";
  assert.throws(() => applyRepairs(ctx, modified, { checker }), /content integrity/);
  assert.throws(() => applyRepairs(ctx, { ...plan, patch: "unrelated patch" }, { checker }), /patch does not match/);
  assert.throws(() => applyRepairs(ctx, { ...plan, unsafe: true }, { checker }), /Invalid repair plan/);
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "before\n");
});

test("repair preview rejects policy, generated assets, API snapshots and loaded bundle changes", async (t) => {
  const { ctx, root } = fixture(t, { "source.txt": "before\n", "custom-policy.json": "{}\n", "old.surface.json": "{}\n", "generated.txt": "owned\n" }, { generated: [{ path: "generated.txt", content: "owned\n" }] });
  ctx.protectedFiles = ["custom-policy.json"];
  for (const path of ["plumb.json", "custom-policy.json", "old.surface.json", "generated.txt"]) {
    const original = readFileSync(join(root, path));
    await assert.rejects(preview(ctx, change(path, "changed\n")), /Repair cannot change/);
    assert.deepEqual(readFileSync(join(root, path)), original);
  }
  const plan = await preview(ctx, change("source.txt", "after\n"));
  const before = readFileSync(join(root, "plumb.json"), "utf8"), forged = structuredClone(plan);
  forged.changes = [{ ...plan.changes[0], path: "plumb.json", before, beforeSha256: digest(before), after: "{}", afterSha256: digest("{}") }]; forged.patch = repairPatch(forged.changes);
  assert.throws(() => applyRepairs(ctx, forged, { checker }), /Repair cannot change/);
});

test("partial or unsupported fixer execution never produces an applicable repair", async (t) => {
  const { ctx, root } = fixture(t, { "source.txt": "before\n", "binary.dat": Buffer.from([0, 1, 2]), "invalid.txt": Buffer.from([192, 128]) });
  let copied;
  await assert.rejects(preview(ctx, async (isolated) => { copied = isolated; writeFileSync(join(isolated, "source.txt"), "partial\n"); return { diagnostics: [{ status: "incomplete", message: "missing tool" }] }; }), /could not complete.*missing tool/);
  assert.equal(existsSync(copied), false);
  await assert.rejects(preview(ctx, change("binary.dat", Buffer.from([0, 3, 4]))), /Binary/);
  await assert.rejects(preview(ctx, change("invalid.txt", "replaced\n")), /valid UTF-8/);
  await assert.rejects(preview(ctx, async () => { throw new Error("tool failed"); }), /tool failed/);
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "before\n");
});

test("conservative repair cannot add, delete or change modes of source files", async (t) => {
  const { ctx, root } = fixture(t, { "source.txt": "before\n" });
  await assert.rejects(preview(ctx, change("new.txt", "new\n")), /cannot add, remove/);
  await assert.rejects(preview(ctx, async (isolated) => { rmSync(join(isolated, "source.txt")); return { diagnostics: [] }; }), /cannot add, remove/);
  if (process.platform !== "win32") {
    await assert.rejects(preview(ctx, async (isolated) => { chmodSync(join(isolated, "source.txt"), 0o700); return { diagnostics: [] }; }), /cannot change file modes/);
    const plan = await preview(ctx, change("source.txt", "after\n")); chmodSync(join(root, "source.txt"), 0o700);
    assert.throws(() => applyRepairs(ctx, plan, { checker }), /Stale repair/);
  }
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "before\n");
});

test("failed replacement rolls back earlier changes and removes temporary files", async (t) => {
  const { ctx, root } = fixture(t, { "one.txt": "one\n", "two.txt": "two\n" });
  const plan = await preview(ctx, async (isolated) => { writeFileSync(join(isolated, "one.txt"), "fixed one\n"); writeFileSync(join(isolated, "two.txt"), "fixed two\n"); return { diagnostics: [] }; });
  let count = 0;
  assert.throws(() => applyRepairs(ctx, plan, { checker, replaceFile: (source, target) => { renameSync(source, target); if (++count === 2) throw new Error("simulated filesystem failure"); } }), /simulated filesystem failure/);
  assert.equal(readFileSync(join(root, "one.txt"), "utf8"), "one\n");
  assert.equal(readFileSync(join(root, "two.txt"), "utf8"), "two\n");
  assert.ok(!readdirSync(root).some((path) => path.startsWith(".plumb-")));
});

test("per-file repair application tolerates unrelated edits but refuses replaced symlink targets", async (t) => {
  const { ctx, root, write } = fixture(t, { "source.txt": "before\n", "other.txt": "unrelated\n" });
  const plan = await preview(ctx, change("source.txt", "after\n")); write("other.txt", "independent change\n");
  applyRepairs(ctx, plan, { checker });
  assert.equal(readFileSync(join(root, "other.txt"), "utf8"), "independent change\n");
  if (process.platform !== "win32") {
    const next = await preview(ctx, change("source.txt", "next\n"));
    rmSync(join(root, "source.txt")); symlinkSync(join(root, "other.txt"), join(root, "source.txt"));
    assert.throws(() => applyRepairs(ctx, next, { checker }), /Symbolic links/);
    assert.equal(readFileSync(join(root, "other.txt"), "utf8"), "independent change\n");
  }
});

test("pinned dependency overlays are bound to repair plans and remain immutable", async (t) => {
  const candidate = fixture(t, { "source.txt": "before\n" }), trusted = fixture(t, { "dependency/index.js": "export const value = 1;\n" });
  const source = join(trusted.root, "dependency"), manifest = join(trusted.root, "inputs.json");
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, files: [{ path: "node_modules/dependency", source, sha256: inputDigest(source) }] }));
  const inputs = loadInputs(manifest, candidate.root);
  const plan = await preview(candidate.ctx, async (isolated) => {
    assert.equal(readFileSync(join(isolated, "node_modules/dependency/index.js"), "utf8"), "export const value = 1;\n");
    return change("source.txt", "after\n")(isolated);
  }, { inputs });
  assert.deepEqual(plan.identity.inputs, inputs.identity);
  assert.throws(() => applyRepairs(candidate.ctx, plan, { checker }), /inputs changed or are unavailable/);
  await assert.rejects(preview(candidate.ctx, change("node_modules/dependency/index.js", "changed\n"), { inputs }), /Materialized input changed/);
  assert.equal(readFileSync(join(source, "index.js"), "utf8"), "export const value = 1;\n");
  applyRepairs(candidate.ctx, plan, { checker, inputs });
  assert.equal(readFileSync(join(candidate.root, "source.txt"), "utf8"), "after\n");
});
