import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { doctorAdapters, loadAdapterRegistry, planAdapters, runAdapters } from "../../../src/adapters.mjs";
import { definePlumb } from "../../../src/config.mjs";
import { digest, globMatches, safePath } from "../../../src/files.mjs";

const python = process.env.PLUMB_TEST_PYTHON ?? "python3";
const script = fileURLToPath(new URL("../adapter.py", import.meta.url));
const invoke = (args, options = {}) => {
  const result = spawnSync(python, ["-I", "-S", script, ...args], { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options });
  assert.equal(result.error, undefined, `The optional Python suite requires a real Python 3.10+ interpreter: ${result.error?.message}`);
  assert.equal(result.signal, null, result.stderr);
  return result;
};
const manifestResult = invoke(["--manifest"]);
assert.equal(manifestResult.status, 0, manifestResult.stderr || manifestResult.stdout);
const manifest = JSON.parse(manifestResult.stdout);

function fixture(t, files = { "main.py": "value = 1\n" }, options = {}, projectRoot = ".", project = {}) {
  const parent = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-python-"));
  const root = join(parent, "candidate"), tools = join(parent, "tools");
  mkdirSync(root); mkdirSync(tools);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const write = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  for (const [path, value] of Object.entries(files)) write(path, value);
  const config = definePlumb({ schemaVersion: 1, preset: "portable", projects: [{ root: projectRoot, profile: "python", options, ...project }] });
  const observed = new Map();
  const readBytes = (path, { allowMissing = false } = {}) => {
    let value;
    try { value = readFileSync(safePath(root, path, { allowMissing })); }
    catch (error) { if (!allowMissing || error.code !== "ENOENT") throw error; value = null; }
    const hash = value === null ? null : digest(value);
    if (observed.has(path) && observed.get(path) !== hash) throw new Error(`Input changed: ${path}`);
    observed.set(path, hash); return value;
  };
  const ctx = { root, config, files: Object.keys(files).sort(), allFiles: Object.keys(files).sort(), ownedFiles: [], matches: globMatches,
    safePath: (path, options) => safePath(root, path, options), readBytes, read: (path, options) => readBytes(path, options)?.toString("utf8") ?? null };
  const registryFile = join(tools, "registry.json");
  writeFileSync(registryFile, JSON.stringify(manifest));
  const registry = loadAdapterRegistry(registryFile, root);
  const request = () => {
    const inputs = ctx.files.map((path) => { let raw; try { raw = readFileSync(join(root, path)); } catch (error) { if (error.code !== "ENOENT") throw error; raw = null; } return { path, sha256: raw === null ? null : digest(raw) }; });
    return { schemaVersion: 1, action: "check", adapter: "python", version: "1.0.0", root, project: config.projects[0], files: inputs, inputs, capabilities: ["syntax", "policy"] };
  };
  const direct = (value = request(), extra = {}) => {
    const result = invoke([], { cwd: root, input: typeof value === "string" ? value : JSON.stringify(value), ...extra });
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, { pass: 0, violation: 1, incomplete: 2 }[output.status]);
    assert.deepEqual(output.versions, manifest.adapters[0].tools);
    return output;
  };
  const run = () => runAdapters(ctx, planAdapters(ctx, { registry }), { registry });
  return { root, tools, ctx, registry, registryFile, write, request, direct, run };
}

test("manifest pins the actual interpreter and adapter with a ready strict registry", (t) => {
  const { registry } = fixture(t), entry = registry.adapters[0];
  assert.equal(entry.id, "python");
  assert.deepEqual(entry.command.slice(1, 3), ["-I", "-S"]);
  assert.equal(entry.command[3], realpathSync(script));
  assert.equal(entry.integrity.length, 2);
  for (const pin of entry.integrity) {
    assert.ok(isAbsolute(pin.path));
    assert.equal(pin.sha256, digest(readFileSync(pin.path)));
  }
  assert.match(entry.tools.python, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(entry.environment, []);
  assert.equal(entry.optionsSchema.additionalProperties, false);
  assert.deepEqual(new Set(entry.rules.map((rule) => rule.capability)), new Set(["syntax", "policy"]));
});

test("real checks cover .py and .pyi sources without running candidate code or local modules", async (t) => {
  const candidate = "from pathlib import Path\nPath('executed').write_text('bad')\nraise RuntimeError('must not execute')\n";
  const { run, root, direct } = fixture(t, { "main.py": candidate, "ast.py": candidate, "sitecustomize.py": candidate, "api.pyi": "def run(value: int) -> str: ...\n" });
  const result = await run();
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.coverage.length, 2);
  for (const row of result.coverage) {
    assert.equal(row.status, "pass");
    assert.equal(row.completed, true);
    assert.deepEqual(row.checkedFiles, ["api.pyi", "ast.py", "main.py", "sitecustomize.py"]);
  }
  assert.equal(direct().status, "pass");
  assert.equal(existsSync(join(root, "executed")), false);
  assert.equal(existsSync(join(root, "__pycache__")), false);
});

test("source evidence hashes raw bytes including encoding cookies and UTF-8 BOMs", async (t) => {
  const raw = Buffer.from("# coding: latin-1\nlabel = 'caf\u00e9'\n", "latin1");
  const { run, direct } = fixture(t, { "latin.py": raw, "bom.py": Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("value = 1\n")]) });
  const output = direct();
  assert.equal(output.status, "pass");
  assert.equal(output.inputs.find((entry) => entry.path === "latin.py").sha256, digest(raw));
  const result = await run();
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.coverage.every((row) => row.status === "pass"), true);
});

test("forbidden imports enforce module prefixes, imported names and project-relative imports", async (t) => {
  const source = "label = '\u00e9'; import subprocess\nfrom pkg import private\nfrom . import hidden\n";
  const options = { forbiddenImports: ["subprocess", "pkg.private", "app.hidden"].map((module) => ({ module, reason: "Use the reviewed boundary" })) };
  const { run, direct } = fixture(t, { "src/app/main.py": source, "src/app/allowed.py": "import subprocess_helper\nfrom pkg import public\n" }, options, "src");
  const output = direct();
  assert.equal(output.status, "violation");
  assert.equal(output.diagnostics.length, 3);
  assert.ok(output.diagnostics.every((item) => item.rule === "python/import" && item.path === "src/app/main.py"));
  assert.equal(output.diagnostics[0].column, source.indexOf("import") + 1);
  const result = await run();
  assert.equal(result.coverage.find((row) => row.capability === "policy").status, "violation");
  assert.equal(result.coverage.find((row) => row.capability === "syntax").status, "pass");
  assert.equal(result.diagnostics.every((item) => item.suppressible), true);
});

test("unresolvable relative and overlapping wildcard imports are incomplete", (t) => {
  const { direct } = fixture(t, { "main.py": "from ..pkg import item\nfrom pkg import *\n" }, { forbiddenImports: [{ module: "pkg.private", reason: "Private boundary" }] });
  const output = direct();
  assert.equal(output.status, "incomplete");
  assert.equal(output.diagnostics.length, 2);
  assert.ok(output.diagnostics.every((item) => item.rule === "python/import" && item.status === "incomplete"));
});

test("real comment directives are protected while strings and docstrings are harmless", async (t) => {
  const controls = ["noqa: F401", "ruff: noqa", "flake8: noqa", "type: ignore[arg-type]", "fmt: off", "fmt: skip", "yapf: disable", "isort: skip_file", "autopep8: off", "pylint: disable=all", "pyright: ignore", "mypy: ignore-errors"];
  const files = Object.fromEntries(controls.map((control, index) => [`deny${String(index).padStart(2, "0")}.py`, `value = 1  # ${control}\n`]));
  files["allow.py"] = `text = '# noqa'\nraw = r'# fmt: off'\n"""# type: ignore\n# ruff: noqa\n"""\n# Explain why noqa is not used here.\n# fmt: on\n`;
  const { run, direct } = fixture(t, files);
  const output = direct();
  assert.equal(output.status, "violation");
  assert.equal(output.diagnostics.length, controls.length);
  assert.ok(output.diagnostics.every((item) => item.rule === "python/directive" && item.line === 1 && item.column === 12));
  const result = await run();
  assert.equal(result.diagnostics.length, controls.length);
  assert.ok(result.diagnostics.every((item) => item.suppressible === false));
});

test("syntax errors, invalid encodings and context-invalid ASTs never claim policy completion", async (t) => {
  const { direct, run } = fixture(t, { "invalid.py": "def broken(:\n", "return.py": "return 1\n", "encoding.py": Buffer.from([255, 10]), "good.py": "pass\n" });
  const output = direct();
  assert.equal(output.status, "incomplete");
  assert.equal(output.diagnostics.length, 3);
  assert.ok(output.diagnostics.every((item) => item.rule === "python/syntax" && item.status === "incomplete"));
  assert.deepEqual(output.coverage.find((row) => row.capability === "policy").files, ["good.py"]);
  const result = await run();
  assert.ok(result.diagnostics.some((item) => item.rule === "adapters.coverage"));
  assert.ok(result.coverage.every((row) => row.status === "incomplete" && !row.completed));
});

test("doctor validates prerequisites and options without reading or claiming source coverage", async (t) => {
  const { direct, request, ctx, registry } = fixture(t, { "main.py": "def broken(:\n" });
  const output = direct({ ...request(), action: "doctor" });
  assert.equal(output.status, "pass");
  assert.deepEqual(output.coverage, []);
  assert.deepEqual(output.inputs, []);
  const result = await doctorAdapters(ctx, { registry });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.checks[0].status, "ready");
  assert.equal(result.checks[0].evidence, "prerequisites-only");
});

test("generic prepare metadata is accepted without running its commands during check or doctor", async (t) => {
  const prepare = [[manifest.adapters[0].command[0], "-I", "-S", "-c", "from pathlib import Path; Path('prepared').write_text('must not run')"]];
  const { run, direct, root, ctx, registry } = fixture(t, undefined, {}, ".", { prepare });
  assert.equal(direct().status, "pass");
  const result = await run();
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.coverage.every((row) => row.status === "pass"));
  const doctor = await doctorAdapters(ctx, { registry });
  assert.deepEqual(doctor.diagnostics, []);
  assert.equal(doctor.checks[0].status, "ready");
  assert.equal(existsSync(join(root, "prepared")), false);
});

test("missing source and wrong expected hashes are incomplete with explicit input evidence", async (t) => {
  const { root, direct, request, run } = fixture(t);
  const changed = request();
  changed.files = changed.files.map((item) => ({ ...item, sha256: "0".repeat(64) })); changed.inputs = changed.files;
  const mismatch = direct(changed);
  assert.equal(mismatch.status, "incomplete");
  assert.match(mismatch.diagnostics[0].message, /hash differs/);
  assert.equal(mismatch.inputs[0].sha256, digest("value = 1\n"));
  assert.ok(mismatch.coverage.every((row) => row.files.length === 0));
  rmSync(join(root, "main.py"));
  const absent = direct();
  assert.equal(absent.status, "incomplete");
  assert.deepEqual(absent.inputs, [{ path: "main.py", sha256: null }]);
  const result = await run();
  assert.ok(result.diagnostics.some((item) => item.rule === "python/input"));
  assert.ok(result.coverage.every((row) => row.status === "incomplete"));
});

test("malformed, unknown and contradictory protocol inputs are rejected", (t) => {
  const { direct, request } = fixture(t);
  const patches = [
    { schemaVersion: 2 }, { schemaVersion: true }, { adapter: "other" }, { version: "2.0.0" }, { action: "fix" }, { unknown: true },
    { capabilities: ["syntax"] }, { capabilities: ["syntax", "syntax", "policy"] }, { capabilities: [null, "policy"] },
    { files: [] }, { inputs: [] }, { files: [{ path: "main.py", sha256: "bad" }] },
    { project: { root: ".", profile: "python", options: { skipSyntax: true } } },
    ...[[], [[]], ["python build.py"], [[false]], [[""]]].map((prepare) => ({ project: { root: ".", profile: "python", prepare } })),
    { project: { root: ".", profile: "python", options: { forbiddenImports: [{ module: "os", reason: "" }] } } },
    { project: { root: ".", profile: "python", options: { forbiddenImports: [{ module: "os", reason: "one" }, { module: "os", reason: "two" }] } } },
  ];
  for (const patch of patches) {
    const result = direct({ ...request(), ...patch });
    assert.equal(result.status, "incomplete", JSON.stringify(patch));
    assert.equal(result.diagnostics[0].rule, "python/protocol");
    assert.deepEqual(result.coverage, []);
  }
  for (const raw of ["{", "null", '{"schemaVersion":1,"schemaVersion":1}', '{"value":NaN}', JSON.stringify(request()) + "\n{}"]) {
    assert.equal(direct(raw).status, "incomplete");
  }
});

test("direct protocol guards source traversal, symlinks, unsupported files and project scope", (t) => {
  const { root, tools, direct, request } = fixture(t, { "src/main.py": "pass\n" }, {}, "src");
  const original = request();
  for (const path of ["../outside.py", "/outside.py", "src/../main.py", "src//main.py", "src\\main.py", "other.py", "src/.git/main.py", "src/main.js"]) {
    const input = [{ path, sha256: "0".repeat(64) }];
    assert.equal(direct({ ...original, files: input, inputs: input }).status, "incomplete", path);
  }
  const outside = join(tools, "outside.py");
  writeFileSync(outside, "secret = 1\n");
  rmSync(join(root, "src/main.py")); symlinkSync(outside, join(root, "src/main.py"));
  const linked = direct(original);
  assert.equal(linked.status, "incomplete");
  assert.match(linked.diagnostics[0].message, /Symbolic links/);
  assert.equal(linked.inputs[0].sha256, null);
});

test("code-pin drift and declared runtime mismatch cannot produce green checks", async (t) => {
  const { root, registryFile, registry, ctx } = fixture(t);
  const changed = structuredClone(manifest);
  changed.adapters[0].integrity[1].sha256 = "0".repeat(64);
  writeFileSync(registryFile, JSON.stringify(changed));
  assert.throws(() => loadAdapterRegistry(registryFile, root), /integrity mismatch/);
  const version = structuredClone(manifest);
  version.adapters[0].tools.python = "0.0.0";
  writeFileSync(registryFile, JSON.stringify(version));
  const wrongVersion = loadAdapterRegistry(registryFile, root);
  const result = await runAdapters(ctx, planAdapters(ctx, { registry: wrongVersion }), { registry: wrongVersion });
  assert.ok(result.diagnostics.some((item) => item.rule === "adapters.protocol" && /requires 0.0.0/.test(item.message)));
  assert.ok(result.coverage.every((row) => row.status === "incomplete"));
  assert.notEqual(registry.sha256, wrongVersion.sha256);
});

test("the adapter refuses a launch without isolated and no-site interpreter flags", (t) => {
  const { root, request } = fixture(t);
  const result = spawnSync(python, ["-I", script], { cwd: root, encoding: "utf8", input: JSON.stringify(request()), timeout: 30000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "incomplete");
  assert.match(output.diagnostics[0].message, /-I -S/);
});
