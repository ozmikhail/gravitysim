import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { doctorAdapters, loadAdapterRegistry, planAdapters, projectFiles, registryIdentity, runAdapters, validateCoverage } from "../src/adapters.mjs";
import { definePlumb } from "../src/config.mjs";
import { digest, globMatches, safePath } from "../src/files.mjs";

const temporary = process.env.PLUMB_TEST_TMP ?? tmpdir();
const nodeExecutable = isAbsolute(process.execPath) ? process.execPath : process.env.PATH.split(delimiter).map((folder) => join(folder, process.execPath)).find(existsSync);
const nodeHash = digest(readFileSync(nodeExecutable));
const program = `import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const request = JSON.parse(readFileSync(0, 'utf8'));
const files = request.files.map(({path}) => ({path, value: readFileSync(resolve(request.root,path))}));
const diagnostics = request.action === 'doctor' ? [] : files.filter(({value}) => value.toString().includes('ERROR')).map(({path}) => ({rule:request.adapter+'/syntax',path,line:1,column:1,message:'Invalid source marker'}));
if (process.env.PLUMB_ADAPTER_UNDECLARED) throw new Error('Inherited undeclared environment');
const response = {schemaVersion:1,adapter:request.adapter,version:'1.0.0',status:diagnostics.length?'violation':'pass',diagnostics,coverage:request.action==='doctor'?[]:request.capabilities.map(capability=>({capability,files:files.map(file=>file.path)})),inputs:request.action==='doctor'?[]:files.map(({path,value})=>({path,sha256:createHash('sha256').update(value).digest('hex')})),versions:{node:process.versions.node}};
RESPONSE_EDIT
process.stdout.write(JSON.stringify(response));
process.exitCode = {pass:0,violation:1,incomplete:2}[response.status];
`;
function fixture(t, files = { "main.py": "print('ok')\n" }, config = {}) {
  const parent = mkdtempSync(join(temporary, "plumb-adapters-")), root = join(parent, "candidate"), tools = join(parent, "tools");
  mkdirSync(root); mkdirSync(tools); t.after(() => rmSync(parent, { recursive: true, force: true }));
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  for (const [path, content] of Object.entries(files)) write(path, content);
  const policy = definePlumb({ schemaVersion: 1, preset: "portable", projects: [{ root: ".", profile: "python" }], ...config });
  const observed = new Map();
  const ctx = { root, config: policy, files: Object.keys(files).filter((path) => !policy.exclude.some((row) => globMatches(row.files, path))).sort(), allFiles: Object.keys(files).sort(), ownedFiles: [], matches: globMatches, safePath: (path, options) => safePath(root, path, options), read: (path, { allowMissing = false } = {}) => {
    let value;
    try { value = readFileSync(safePath(root, path), "utf8"); } catch (error) { if (!allowMissing || error.code !== "ENOENT") throw error; value = null; }
    const hash = value === null ? null : digest(value);
    if (observed.has(path) && observed.get(path) !== hash) throw new Error(`Input changed: ${path}`);
    observed.set(path, hash); return value;
  } };
  const script = join(tools, "adapter.mjs"), registryFile = join(tools, "registry.json");
  const registry = (edit = "", changes = {}) => {
    writeFileSync(script, program.replace("RESPONSE_EDIT", edit));
    const descriptor = { id: "python", version: "1.0.0", files: ["**/*.py"], capabilities: ["syntax"], command: [nodeExecutable, script], integrity: [{ path: nodeExecutable, sha256: nodeHash }, { path: script, sha256: digest(readFileSync(script)) }], environment: [], tools: { node: process.versions.node }, rules: [{ id: "python/syntax", description: "Python syntax is valid", remedy: "Correct source syntax" }], ...changes };
    writeFileSync(registryFile, JSON.stringify({ schemaVersion: 1, adapters: [descriptor] }));
    return loadAdapterRegistry(registryFile, root);
  };
  return { root, ctx, write, tools, script, registryFile, registry, observed };
}

test("coverage plans preserve nested ownership and reasoned exclusions", (t) => {
  const { ctx } = fixture(t, { "root.ts": "", "a/main.tsx": "", "vendor/skip.ts": "", "README.md": "" }, { projects: [{ root: ".", profile: "typescript" }, { root: "a", profile: "react" }], exclude: [{ files: ["vendor/**"], reason: "checked upstream" }] });
  const plan = planAdapters(ctx);
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(projectFiles(ctx, ctx.config.projects[0]), ["root.ts"]);
  assert.deepEqual(plan.checks.find((check) => check.id === "javascript.lint:a").files, ["a/main.tsx"]);
  assert.deepEqual(plan.files.find((file) => file.path === "a/main.tsx").owners, [{ root: "a", profile: "react" }]);
  assert.deepEqual(plan.files.find((file) => file.path === "vendor/skip.ts").reasons, ["checked upstream"]);
  assert.equal(plan.files.find((file) => file.path === "vendor/skip.ts").excluded, true);
});

test("unapproved profiles and unowned registered source cannot silently disappear", (t) => {
  const { ctx, registry } = fixture(t);
  assert.ok(planAdapters(ctx).diagnostics.some((item) => item.rule === "adapters.registry"));
  const approved = registry();
  const unowned = { ...ctx, config: definePlumb({ schemaVersion: 1, preset: "ozlabs", projects: [] }) };
  assert.ok(planAdapters(unowned, { registry: approved }).diagnostics.some((item) => item.rule === "projects.uncovered" && item.path === "main.py"));
});

test("registry checks code boundaries, hashes, executable pins and option schemas", (t) => {
  const { root, registry, registryFile, script } = fixture(t);
  const approved = registry(); assert.equal(approved.adapters[0].id, "python");
  writeFileSync(join(root, "registry.json"), readFileSync(registryFile));
  assert.throws(() => loadAdapterRegistry(join(root, "registry.json"), root), /outside the candidate/);
  assert.throws(() => registry("", { integrity: [{ path: nodeExecutable, sha256: nodeHash }] }), /must be pinned/);
  assert.throws(() => registry("", { integrity: [{ path: nodeExecutable, sha256: "0".repeat(64) }, { path: script, sha256: "0".repeat(64) }] }), /integrity mismatch/);
  assert.throws(() => registry("", { optionsSchema: { type: "object", properties: {}, additionalProperties: true } }), /constrain additionalProperties/);
  writeFileSync(join(root, "adapter.mjs"), "throw new Error('candidate code');\n");
  assert.throws(() => registry("", { command: [nodeExecutable, "adapter.mjs"] }), /relative command file/);
  assert.throws(() => registry("", { command: [nodeExecutable, "--import=adapter.mjs", script] }), /absolute pinned files/);
  assert.throws(() => registry("", { command: [nodeExecutable, "-m", "candidate"] }), /module-name resolution/);
  const strict = registry("", { optionsSchema: { type: "object", properties: { level: { enum: ["strict"] } }, required: ["level"], additionalProperties: false } });
  assert.ok(planAdapters({ ...fixture(t).ctx }, { registry: strict }).diagnostics.some((item) => /missing level/.test(item.message)));
});

test("an actual external process returns file coverage, source hashes and precise findings", async (t) => {
  const { ctx, registry } = fixture(t, { "main.py": "print('ok')\n", "nested/bad.py": "ERROR\n" });
  const approved = registry(), planned = planAdapters(ctx, { registry: approved });
  const result = await runAdapters(ctx, planned, { registry: approved });
  assert.deepEqual(result.diagnostics.map(({ rule, path }) => [rule, path]), [["python/syntax", "nested/bad.py"]]);
  assert.equal(result.coverage[0].completed, true);
  assert.equal(result.coverage[0].status, "violation");
  assert.equal(result.coverage[0].evidence, "adapter-reported");
  assert.deepEqual(result.coverage[0].checkedFiles, ["main.py", "nested/bad.py"]);
  assert.equal(result.versions.node, process.versions.node);
});

test("external input evidence hashes original bytes through both context read APIs", async (t) => {
  const bytes = Buffer.from("# coding: latin-1\nname = 'caf\xe9'\n", "latin1");
  assert.notEqual(digest(bytes), digest(bytes.toString("utf8")));
  for (const rawReader of [false, true]) {
    const { ctx, registry } = fixture(t, { "main.py": bytes });
    let reads = 0;
    if (rawReader) {
      ctx.readBytes = (path) => { reads++; return readFileSync(ctx.safePath(path)); };
      ctx.read = () => { throw new Error("Raw-byte evidence must not decode the input"); };
    }
    const approved = registry();
    const result = await runAdapters(ctx, planAdapters(ctx, { registry: approved }), { registry: approved });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.coverage[0].status, "pass");
    if (rawReader) assert.ok(reads >= 2);
  }
});

test("successful external checks receive only declared environment inputs", async (t) => {
  const { ctx, registry } = fixture(t);
  const previous = process.env.PLUMB_ADAPTER_UNDECLARED;
  process.env.PLUMB_ADAPTER_UNDECLARED = "must not reach adapter";
  try {
    const approved = registry();
    const result = await runAdapters(ctx, planAdapters(ctx, { registry: approved }), { registry: approved });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.coverage[0].status, "pass");
    assert.deepEqual(registryIdentity(approved).adapters[0].environment.names, []);
  } finally { if (previous === undefined) delete process.env.PLUMB_ADAPTER_UNDECLARED; else process.env.PLUMB_ADAPTER_UNDECLARED = previous; }
});

test("empty, unexpected and duplicate coverage cannot claim successful completion", () => {
  const planned = [{ id: "syntax:.", root: ".", files: ["a.py"], evidence: "adapter-reported" }];
  for (const returned of [[], [{ id: "syntax:.", checkedFiles: [], status: "pass" }], [{ id: "syntax:.", checkedFiles: ["other.py"], status: "pass" }], [{ id: "syntax:.", checkedFiles: ["a.py", "a.py"], status: "pass" }], [{ id: "syntax:.", checkedFiles: [], notApplicable: [{ path: "a.py", reason: "ignored" }], status: "not-applicable" }]]) {
    assert.ok(validateCoverage(planned, returned).diagnostics.length);
  }
  const format = [{ ...planned[0], allowNotApplicable: true }];
  assert.equal(validateCoverage(format, [{ id: "syntax:.", checkedFiles: [], notApplicable: [{ path: "a.py", reason: "No supported parser" }], status: "not-applicable" }]).coverage[0].status, "not-applicable");
  assert.ok(validateCoverage(format, [{ id: "syntax:.", checkedFiles: [], notApplicable: [{ path: "a.py", reason: "No supported parser" }], status: "pass" }]).diagnostics.length);
});

test("external protocol rejects missing hashes, out-of-scope claims and contradictory statuses", async (t) => {
  const edits = ["response.inputs = [];", "response.inputs[0].sha256 = '0'.repeat(64);", "response.coverage[0].files = [];", "response.coverage.push(response.coverage[0]);", "response.diagnostics = [{rule:'python/unknown',path:'main.py',message:'unknown'}]; response.status='violation';", "response.diagnostics = [{rule:'python/syntax',path:'../outside.py',message:'outside'}]; response.status='violation';", "response.versions.node = '0.0.0';"];
  for (const edit of edits) {
    const { ctx, registry } = fixture(t);
    const approved = registry(edit);
    const result = await runAdapters(ctx, planAdapters(ctx, { registry: approved }), { registry: approved });
    assert.ok(result.diagnostics.some((item) => item.status === "incomplete"), edit);
  }
});

test("changed adapter code is refused before it can execute", async (t) => {
  const { ctx, registry, script } = fixture(t), approved = registry();
  writeFileSync(script, "throw new Error('tampered');\n");
  let calls = 0;
  const result = await runAdapters(ctx, planAdapters(ctx, { registry: approved }), { registry: approved, execute: async () => { calls++; return { code: 0, stdout: "{}", stderr: "" }; } });
  assert.equal(calls, 0);
  assert.ok(result.diagnostics.some((item) => /integrity mismatch/.test(item.message)));
});

test("isolated subjects retain the original candidate code boundary", async (t) => {
  const original = fixture(t), approved = original.registry();
  const candidateCode = join(original.root, "adapter.mjs");
  writeFileSync(candidateCode, readFileSync(original.script));
  rmSync(original.script); symlinkSync(candidateCode, original.script);
  const { ctx } = fixture(t);
  let calls = 0;
  const result = await runAdapters(ctx, planAdapters(ctx, { registry: approved }), { registry: approved, execute: async () => { calls++; return { code: 0, stdout: "{}", stderr: "" }; } });
  assert.equal(calls, 0);
  assert.ok(result.diagnostics.some((item) => /outside the candidate/.test(item.message)));
});

test("checks and doctor reject changes to observed source inputs", async (t) => {
  for (const doctor of [false, true]) {
    const { ctx, registry } = fixture(t);
    const approved = registry("const {writeFileSync} = await import('node:fs'); writeFileSync(resolve(request.root, 'main.py'), 'changed\\n');");
    const result = doctor ? await doctorAdapters(ctx, { registry: approved }) : await runAdapters(ctx, planAdapters(ctx, { registry: approved }), { registry: approved });
    assert.ok(result.diagnostics.some((item) => item.status === "incomplete" && /(?:changed|mutated)/i.test(item.message)));
    assert.equal(result.checks.some((item) => ["pass", "ready"].includes(item.status)), false);
  }
});

test("doctor probes an external adapter without claiming executed source checks", async (t) => {
  const { ctx, registry } = fixture(t), approved = registry();
  const result = await doctorAdapters(ctx, { registry: approved });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.checks[0].status, "ready");
  assert.equal(result.checks[0].evidence, "prerequisites-only");
  const suggestions = await doctorAdapters({ ...ctx, config: definePlumb({ schemaVersion: 1, preset: "portable" }) }, { registry: approved });
  assert.equal(suggestions.suggestions[0].project.profile, "python");
});

test("native Ruby checks require RuboCop's inspected-file evidence", async (t) => {
  const { ctx } = fixture(t, { "main.rb": "puts 'ok'\n" }, { projects: [{ root: ".", profile: "ruby" }] });
  const execute = (files) => async (command) => command.at(-1) === "--version" ? { code: 0, stdout: "1.0.0", stderr: "" } : { code: 0, stdout: JSON.stringify({ files: files.map((path) => ({ path, offenses: [] })), summary: { inspected_file_count: files.length } }), stderr: "" };
  const planned = planAdapters(ctx);
  const complete = await runAdapters(ctx, planned, { execute: execute(["main.rb"]) });
  assert.deepEqual(complete.diagnostics, []);
  assert.equal(complete.coverage[0].evidence, "tool-reported");
  const absent = await runAdapters(ctx, planned, { execute: execute([]) });
  assert.ok(absent.diagnostics.some((item) => item.status === "incomplete"));
  const malformed = await runAdapters(ctx, planned, { execute: async () => ({ code: 0, stdout: "1.0.0", stderr: "" }) });
  assert.ok(malformed.diagnostics.some((item) => item.rule === "adapters.protocol"));
});

test("C++ coverage identifies explicit translation-unit inputs without claiming header inspection", async (t) => {
  const { ctx, root, write } = fixture(t, { "main.cpp": "int main() {}\n", "main.hpp": "", ".clang-format-ignore": "# none\n", "build/compile_commands.json": "[]" }, { projects: [{ root: ".", profile: "cpp", compileCommands: "build" }] });
  write("build/compile_commands.json", JSON.stringify([{ directory: root, file: "main.cpp", arguments: ["c++", "-c", "main.cpp"] }]));
  const result = await runAdapters(ctx, planAdapters(ctx), { execute: async (command) => ({ code: 0, stdout: command.at(-1) === "--version" ? "18.1.8" : "", stderr: "" }) });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.coverage.find((item) => item.id === "cpp.lint:.").checkedFiles, ["main.cpp"]);
  assert.equal(result.coverage.every((item) => item.evidence === "explicit-inputs"), true);
});

test("the shared JavaScript contract refuses a pack that omits coverage", async (t) => {
  const { ctx } = fixture(t, { "main.ts": "export const value = 1;\n" }, { projects: [{ root: ".", profile: "typescript" }] });
  const planned = planAdapters(ctx);
  const fake = (coverage) => async () => ({ rules: () => [], check: () => ({ diagnostics: [], coverage }) });
  const missing = await runAdapters(ctx, planned, { loadJavascript: fake([]) });
  assert.ok(missing.diagnostics.some((item) => item.rule === "adapters.coverage"));
  const complete = await runAdapters(ctx, planned, { loadJavascript: fake(planned.checks.map((check) => ({ id: check.id, checkedFiles: check.files, status: "pass" }))) });
  assert.deepEqual(complete.diagnostics, []);
});

test("coverage outcomes cannot contradict findings or hide an incomplete check", async (t) => {
  const { ctx } = fixture(t, { "main.ts": "export const value = 1;\n" }, { projects: [{ root: ".", profile: "typescript" }] });
  const planned = planAdapters(ctx);
  const finding = { rule: "javascript/example", path: "main.ts", message: "source error", check: "javascript.lint:." };
  const invoke = (rowStatus, status) => runAdapters(ctx, planned, { loadJavascript: async () => ({ rules: () => [], check: () => ({ diagnostics: [{ ...finding, ...(status ? { status } : {}) }], coverage: planned.checks.map((check) => ({ id: check.id, checkedFiles: check.files, status: check.id === finding.check ? rowStatus : "pass" })) }) }) });
  const violation = await invoke("pass");
  assert.equal(violation.checks.find((check) => check.id === finding.check).status, "violation");
  const incomplete = await invoke("pass", "incomplete");
  assert.equal(incomplete.coverage.find((check) => check.id === finding.check).completed, false);
  assert.equal(incomplete.checks.find((check) => check.id === finding.check).status, "incomplete");
  const unsupported = await invoke("incomplete");
  assert.ok(unsupported.diagnostics.some((item) => item.rule === "adapters.protocol" && item.status === "incomplete"));
  assert.equal(unsupported.coverage.find((check) => check.id === finding.check).completed, false);
});
