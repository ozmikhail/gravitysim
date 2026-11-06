import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("..", import.meta.url));
const temporary = process.env.PLUMB_TEST_TMP ?? fileURLToPath(new URL("../../.plumb-tests", import.meta.url));
mkdirSync(temporary, { recursive: true });

function fixture(t) {
  const root = mkdtempSync(join(temporary, "identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const core = join(root, "node_modules/@ozlabs/plumb"), pack = join(root, "node_modules/@ozlabs/plumb-javascript");
  mkdirSync(core, { recursive: true }); mkdirSync(pack, { recursive: true });
  for (const path of ["package.json", "bin", "src"]) cpSync(join(source, path), join(core, path), { recursive: true });
  const manifest = (name) => writeFileSync(join(pack, "package.json"), JSON.stringify({ name, type: "module", exports: "./index.mjs" }));
  manifest("@ozlabs/plumb-javascript");
  // This is a loader fixture, not a substitute for the actual JavaScript engine suite.
  writeFileSync(join(pack, "index.mjs"), "export const rules = () => []; export const check = () => ({diagnostics: []});\n");
  writeFileSync(join(pack, "policy.json"), '{"setting":1}\n');
  const inspect = (compiled = false) => spawnSync(process.execPath, ["--input-type=module", "-e", `${compiled ? 'globalThis.__PLUMB_BUILD_ID__ = "compiled-core";' : ""} const engine = await import(${JSON.stringify(pathToFileURL(join(core, "src/engine.mjs")).href)}); const pack = await engine.javascriptPack(); process.stdout.write(JSON.stringify(engine.checkerIdentity(pack.identity)));`], { cwd: root, encoding: "utf8" });
  return { pack, inspect, manifest };
}

test("checker identity includes the resolved optional pack independently of core or build identity", (t) => {
  const { pack, inspect } = fixture(t);
  const first = inspect(); assert.equal(first.status, 0, first.stderr);
  writeFileSync(join(pack, "policy.json"), '{"setting":2}\n');
  const second = inspect(); assert.equal(second.status, 0, second.stderr);
  const before = JSON.parse(first.stdout), after = JSON.parse(second.stdout);
  assert.equal(before.sha256, after.sha256);
  assert.notEqual(before.javascript.sha256, after.javascript.sha256);
  assert.equal(after.javascript.version, undefined);
  const compiled = inspect(true); assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(JSON.parse(compiled.stdout).sha256, "compiled-core");
  assert.deepEqual(JSON.parse(compiled.stdout).javascript, after.javascript);
});

test("the optional pack must be the Plumb JavaScript package", (t) => {
  const { inspect, manifest } = fixture(t);
  manifest("other-pack");
  const result = inspect();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be @ozlabs\/plumb-javascript/);
});
