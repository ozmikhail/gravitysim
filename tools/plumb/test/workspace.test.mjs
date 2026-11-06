import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { inventory } from "../src/files.mjs";
import { copyWorkspace, inputDigest, loadInputs, materializeInputs } from "../src/workspace.mjs";

const temporaryRoot = process.env.PLUMB_TEST_TMP ?? fileURLToPath(new URL("../../.plumb-tests", import.meta.url));
mkdirSync(temporaryRoot, { recursive: true });
function fixture(t, files = {}) {
  const root = mkdtempSync(join(temporaryRoot, "workspace-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  for (const [path, content] of Object.entries(files)) write(path, content);
  return { root, write };
}
test("isolated worktree copies include only selected and explicitly declared extra files", (t) => {
  const { root, write } = fixture(t, { "entry.txt": "value\n" });
  write("build/generated.txt", "declared\n"); write("build/unlisted.txt", "not declared\n");
  const copied = copyWorkspace(root, { files: ["entry.txt"], extraFiles: ["build/generated.txt"], temporaryRoot }); t.after(copied.cleanup);
  assert.equal(readFileSync(join(copied.root, "build/generated.txt"), "utf8"), "declared\n");
  assert.equal(existsSync(join(copied.root, "build/unlisted.txt")), false);
  assert.throws(() => copyWorkspace(root, { extraFiles: ["missing.txt"], temporaryRoot }), /ENOENT/);
  assert.throws(() => copyWorkspace(root, { extraFiles: [".git/config"], temporaryRoot }), /Reserved/);
  assert.throws(() => copyWorkspace(root, { temporaryRoot: join(root, "temporary") }), /outside the candidate/);
  write("entry.txt", "changed\n"); assert.throws(() => copied.verify(), /Workspace inputs changed/);
});

function approved(t, candidate, files) {
  const trusted = fixture(t);
  const manifest = join(trusted.root, "inputs.json");
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, files: files.map(([path, source]) => ({ path, source, sha256: inputDigest(source) })) }));
  return { manifest, loaded: loadInputs(manifest, candidate) };
}

test("approved input overlays pin content, modes and empty directories without following dependencies", (t) => {
  const candidate = fixture(t, { "entry.txt": "source\n" }), source = fixture(t, { "dependency/index.js": "export const value = 1;\n", "generated.txt": "prepared\n" });
  mkdirSync(join(source.root, "dependency/empty"));
  const { loaded } = approved(t, candidate.root, [["node_modules/dependency", join(source.root, "dependency")], ["build/generated.txt", join(source.root, "generated.txt")]]);
  const copied = copyWorkspace(candidate.root, { temporaryRoot }); t.after(copied.cleanup);
  const overlay = materializeInputs(copied.root, loaded);
  assert.equal(readFileSync(join(copied.root, "node_modules/dependency/index.js"), "utf8"), "export const value = 1;\n");
  assert.ok(existsSync(join(copied.root, "node_modules/dependency/empty")));
  assert.equal(readFileSync(join(copied.root, "build/generated.txt"), "utf8"), "prepared\n");
  assert.ok(!inventory(copied.root).files.some((path) => path.includes("node_modules")));
  assert.equal(overlay.verify(), true);
  writeFileSync(join(copied.root, "node_modules/dependency/new.js"), "created\n");
  assert.throws(() => overlay.verify(), /Materialized input changed/);
  source.write("generated.txt", "changed\n"); assert.throws(() => loaded.verify(), /Approved input changed/);
});

test("input drift, manifest drift and conflicting destinations refuse before copying", (t) => {
  const candidate = fixture(t, { "entry.txt": "source\n" }), source = fixture(t, { "one.txt": "one\n", "two.txt": "two\n" });
  const first = approved(t, candidate.root, [["entry.txt", join(source.root, "one.txt")], ["new.txt", join(source.root, "two.txt")]]);
  assert.throws(() => materializeInputs(candidate.root, first.loaded), /collides/);
  assert.equal(existsSync(join(candidate.root, "new.txt")), false); assert.equal(readFileSync(join(candidate.root, "entry.txt"), "utf8"), "source\n");
  const next = approved(t, candidate.root, [["new.txt", join(source.root, "one.txt")]]);
  writeFileSync(next.manifest, '{"schemaVersion":1,"files":[]}');
  assert.throws(() => next.loaded.verify(), /manifest changed/);
  const stale = approved(t, candidate.root, [["new.txt", join(source.root, "one.txt")]]);
  source.write("one.txt", "changed\n");
  assert.throws(() => materializeInputs(candidate.root, stale.loaded), /Approved input changed/);
  assert.throws(() => loadInputs(stale.manifest, candidate.root), /pin does not match/);
  assert.equal(existsSync(join(candidate.root, "new.txt")), false);
});

test("input-copy failures remove created files and directories without changing snapshot files", (t) => {
  const candidate = fixture(t, { "entry.txt": "source\n" }), source = fixture(t, { "nested/input.txt": "input\n" });
  if (process.platform !== "win32") chmodSync(join(source.root, "nested"), 0o555);
  const { loaded } = approved(t, candidate.root, [["generated/deep", join(source.root, "nested")]]);
  let calls = 0;
  const changing = { ...loaded, verify() { if (++calls === 2) source.write("nested/input.txt", "changed\n"); return loaded.verify(); } };
  assert.throws(() => materializeInputs(candidate.root, changing), /Approved input changed/);
  assert.deepEqual(readdirSync(candidate.root), ["entry.txt"]);
  assert.equal(readFileSync(join(candidate.root, "entry.txt"), "utf8"), "source\n");
  if (process.platform !== "win32") chmodSync(join(source.root, "nested"), 0o755);
});

test("input manifests reject candidate control, metadata paths and overlapping destinations", (t) => {
  const candidate = fixture(t, { "entry.txt": "source\n", "inputs.json": '{"schemaVersion":1,"files":[]}' }), source = fixture(t, { "data.txt": "input\n" });
  assert.throws(() => loadInputs(join(candidate.root, "inputs.json"), candidate.root), /outside the candidate/);
  assert.throws(() => approved(t, candidate.root, [[".git/config", join(source.root, "data.txt")]]), /Reserved/);
  assert.throws(() => approved(t, candidate.root, [["node_modules", source.root], ["node_modules/data.txt", join(source.root, "data.txt")]]), /must not overlap/);
  if (process.platform !== "win32") {
    const { loaded } = approved(t, candidate.root, [["new.txt", join(source.root, "data.txt")]]);
    chmodSync(join(source.root, "data.txt"), 0o700);
    assert.throws(() => loaded.verify(), /Approved input changed/);
  }
});

test("input sources and destinations reject symlinks", { skip: process.platform === "win32" }, (t) => {
  const candidate = fixture(t, { "entry.txt": "source\n" }), source = fixture(t, { "data.txt": "input\n" });
  symlinkSync(join(source.root, "data.txt"), join(source.root, "linked.txt"));
  assert.throws(() => inputDigest(join(source.root, "linked.txt")), /symlink/i);
  assert.throws(() => inputDigest(source.root), /regular files and directories/);
  const { loaded } = approved(t, candidate.root, [["nested/data.txt", join(source.root, "data.txt")]]);
  symlinkSync(source.root, join(candidate.root, "nested"));
  assert.throws(() => materializeInputs(candidate.root, loaded), /symlink/);
});
