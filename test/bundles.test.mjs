import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { diffPolicies, resolvePolicy } from "../src/bundles.mjs";
import { schema, validateSchema } from "../src/config.mjs";
import { canonical, digest } from "../src/files.mjs";

const temporary = process.env.PLUMB_TEST_TMP ?? fileURLToPath(new URL("../../.plumb-tests", import.meta.url));
mkdirSync(temporary, { recursive: true });
function fixture(t) {
  const root = mkdtempSync(join(temporary, "bundles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => { const source = typeof value === "string" ? value : `${JSON.stringify(value)}\n`; mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); return { path, sha256: digest(source) }; };
  const resolve = (file = "plumb.json") => resolvePolicy(join(root, file), readFileSync(join(root, file), "utf8"), { schema, validate: validateSchema });
  return { root, write, resolve };
}

test("pinned bundles compose additive rules with deterministic per-field origins and input hashes", (t) => {
  const { root, write, resolve } = fixture(t);
  const reference = write("policies/common.json", { schemaVersion: 1, preset: "portable", files: { required: ["${root}/README.md"] }, projects: [{ root: "${root}", profile: "typescript" }] });
  write("plumb.json", { schemaVersion: 1, bundles: [{ ...reference, bindings: { root: "api" } }], files: { required: ["AGENTS.md"] }, policy: { protected: ["scripts/**"] } });
  const result = resolve();
  assert.equal(result.value.preset, "portable");
  assert.deepEqual(result.value.files.required, ["api/README.md", "AGENTS.md"]);
  assert.deepEqual(result.value.projects, [{ root: "api", profile: "typescript" }]);
  assert.equal(result.origins["/files/required/0"][0].path, join(root, "policies/common.json"));
  assert.equal(result.origins["/files/required/1"][0].path, join(root, "plumb.json"));
  assert.equal(result.inputs.length, 2);
  assert.equal(canonical(result), canonical(resolve()));
  assert.equal(Object.hasOwn(result.value, "bundles"), false);
});

test("ordinary policies retain defaults and explicit allowances without inherited overlays", (t) => {
  const { write, resolve } = fixture(t);
  write("plumb.json", { schemaVersion: 1, exclude: [{ files: ["vendor/**"], reason: "vendored" }] });
  const result = resolve();
  assert.equal(result.value.preset, "ozlabs");
  assert.equal(result.value.exclude.length, 1);
  assert.equal(result.origins["/preset"][0].default, true);
});

test("overlays cannot widen allowances, change hidden source defaults or override imported scalars", (t) => {
  const { write, resolve } = fixture(t);
  const reference = write("base.json", { schemaVersion: 1, preset: "portable", files: { maxLines: 100 } });
  for (const overlay of [
    { exclude: [{ files: ["src/**"], reason: "skip" }] },
    { exceptions: [{ id: "skip", rules: ["files.names"], files: ["**"], reason: "skip", max: 1 }] },
    { format: { ignore: [{ path: "src/**", reason: "skip" }] } },
    { javascript: { source: ["elsewhere/**"] } },
    { javascript: { errorFactory: { message: "skip", allowIn: ["**"] } } },
    { files: { maxLines: 200 } },
    { files: { maxLines: 50 } },
  ]) {
    write("plumb.json", { schemaVersion: 1, bundles: [reference], ...overlay });
    assert.throws(() => resolve(), /overlay|override|reconfigure|Conflicting/);
  }
  const strict = write("strict.json", { schemaVersion: 1, files: { required: ["README.md"] } });
  write("plumb.json", { schemaVersion: 1, preset: "portable", bundles: [strict] });
  assert.throws(() => resolve(), /Conflicting/);
  write("plumb.json", { schemaVersion: 1, preset: "ozlabs", bundles: [reference] });
  assert.equal(resolve().value.preset, "ozlabs");
});

test("shared allowance rows can be repeated exactly but cannot be replaced", (t) => {
  const { write, resolve } = fixture(t);
  const exclude = [{ files: ["vendor/**"], reason: "upstream" }];
  const reference = write("base.json", { schemaVersion: 1, preset: "portable", exclude });
  write("plumb.json", { schemaVersion: 1, bundles: [reference], exclude });
  assert.deepEqual(resolve().value.exclude, exclude);
  write("plumb.json", { schemaVersion: 1, bundles: [reference], exclude: [] });
  assert.throws(() => resolve(), /allowances/);
});

test("project templates allow sibling additions but reject replacement and nested ownership", (t) => {
  const { write, resolve } = fixture(t);
  const project = { root: "api", profile: "typescript" };
  const reference = write("base.json", { schemaVersion: 1, preset: "portable", projects: [project] });
  write("plumb.json", { schemaVersion: 1, bundles: [reference], projects: [project, { root: "web", profile: "react" }] });
  assert.equal(resolve().value.projects.length, 2);
  for (const root of ["api", "api/a", "."]) {
    write("plumb.json", { schemaVersion: 1, bundles: [reference], projects: [{ root, profile: "react" }] });
    assert.throws(() => resolve(), /project owner/);
  }
});

test("bundle pins, shapes, binding names and literal paths are validated before use", (t) => {
  const { write, resolve } = fixture(t);
  const reference = write("base.json", { schemaVersion: 1, preset: "portable", files: { required: ["${root}/README.md"] } });
  for (const row of [
    { ...reference, sha256: "0".repeat(64), bindings: { root: "api" } },
    { ...reference, sha256: "not-a-digest", bindings: { root: "api" } },
    { ...reference, unknown: true, bindings: { root: "api" } },
    reference,
    { ...reference, bindings: { root: "api", unused: "extra" } },
    { ...reference, bindings: { root: "../outside" } },
    { ...reference, bindings: { root: "**" } },
  ]) {
    write("plumb.json", { schemaVersion: 1, bundles: [row] });
    assert.throws(() => resolve(), /hash|match|unknown|binding|Binding|repository|literal/);
  }
});

test("nested bundles can forward path bindings without interpolating regular expressions", (t) => {
  const { write, resolve } = fixture(t);
  const base = write("base.json", { schemaVersion: 1, preset: "portable", projects: [{ root: "${root}", profile: "ruby" }], files: { names: [{ files: ["${root}/**"], pattern: "^${literal}$", reason: "literal pattern" }] } });
  const outer = write("outer.json", { schemaVersion: 1, bundles: [{ ...base, bindings: { root: "${root}" } }] });
  write("plumb.json", { schemaVersion: 1, bundles: [{ ...outer, bindings: { root: "api" } }] });
  const result = resolve();
  assert.equal(result.value.projects[0].root, "api");
  assert.equal(result.value.files.names[0].pattern, "^${literal}$");
  assert.equal(result.inputs.length, 3);
});

test("traversal, symlink escapes, missing inputs and recursive bundle cycles fail closed", (t) => {
  const { root, write, resolve } = fixture(t);
  const outside = fixture(t);
  const external = outside.write("external.json", { schemaVersion: 1, preset: "portable" });
  const externalPath = join(outside.root, external.path);
  symlinkSync(externalPath, join(root, "linked.json"));
  for (const path of ["../outside.json", "linked.json", "missing.json", "https://example.invalid/policy.json"]) {
    write("plumb.json", { schemaVersion: 1, bundles: [{ path, sha256: external.sha256 }] });
    assert.throws(() => resolve(), /parent|Symbolic|ENOENT|local filesystem/);
  }
  write("plumb.json", { schemaVersion: 1, bundles: [{ path: externalPath, sha256: external.sha256 }] });
  assert.equal(resolve().value.preset, "portable");
  const recursive = write("second.json", { schemaVersion: 1, bundles: [{ path: "plumb.json", sha256: "0".repeat(64) }] });
  write("plumb.json", { schemaVersion: 1, bundles: [recursive] });
  assert.throws(() => resolve(), /cycle/);
});

test("policy diffs preserve changed values and provenance without inventing an automatic approval", (t) => {
  const { write, resolve } = fixture(t);
  write("plumb.json", { schemaVersion: 1, preset: "portable", files: { required: ["README.md"], maxLines: 400 } });
  const before = resolve();
  write("plumb.json", { schemaVersion: 1, preset: "portable", files: { required: ["README.md", "AGENTS.md"] }, policy: { protected: ["src/**"] } });
  const after = resolve(), rows = diffPolicies(before, after);
  assert.deepEqual(rows.map(({ path, kind }) => ({ path, kind })), [{ path: "/files/maxLines", kind: "removed" }, { path: "/files/required", kind: "changed" }, { path: "/policy", kind: "added" }]);
  assert.ok(rows[1].beforeOrigins.length);
  assert.ok(rows[1].afterOrigins.length);
  assert.deepEqual(diffPolicies(after, after), []);
});
