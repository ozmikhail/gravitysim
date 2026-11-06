import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { definePlumb } from "../src/config.mjs";
import { checkRepository, report } from "../src/engine.mjs";
import { canonical, globMatches, inventory, safePath } from "../src/files.mjs";
import { applyExceptions } from "../src/policy.mjs";
import { executeSteps, run } from "../src/process.mjs";
import { main } from "../src/cli.mjs";

const base = process.env.PLUMB_TEST_TMP ?? fileURLToPath(new URL("../../.plumb-test", import.meta.url));
mkdirSync(base, { recursive: true });
function fixture(t, config = {}, files = {}) {
  const root = mkdtempSync(join(base, "kernel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  write("plumb.json", JSON.stringify({ schemaVersion: 1, preset: "portable", ...config }));
  for (const [path, text] of Object.entries(files)) write(path, text);
  return { root, write };
}
async function cli(args) {
  let text = ""; const code = await main([...args, "--format", "json"], (chunk) => { text += chunk; });
  return { code, body: JSON.parse(text) };
}

test("strict schema rejects unknown fields, missing reasons, escape paths and duplicate identities", () => {
  for (const config of [{ checks: [] }, { schemVersion: 1 }, { exclude: [{ files: ["src/**"] }] }, { projects: [{ root: "../outside", profile: "ruby" }] }, { exceptions: [{ id: "debt", rules: ["files.names"], files: ["src/**"], reason: " ", max: 1 }] }, { projects: [{ root: ".", profile: "ruby" }, { root: "./", profile: "ruby" }] }]) assert.throws(() => definePlumb({ schemaVersion: 1, ...config }));
  const config = definePlumb({ schemaVersion: 1, projects: [{ root: "./", profile: "typescript" }] });
  assert.equal(config.projects[0].root, "."); assert.ok(Object.isFrozen(config.projects[0]));
  assert.throws(() => { config.projects.push({}); });
});

test("one normalized glob vocabulary covers root, Windows paths and brace scopes", () => {
  for (const [pattern, path] of [["./**", "src/a.ts"], [".", "a.rb"], ["./src/**/*.{ts,tsx}", "src/a.ts"], ["src\\**\\*.tsx", "src\\ui\\card.tsx"], ["docs/", "docs/guide.md"]]) assert.equal(globMatches(pattern, path), true, `${pattern} ${path}`);
  assert.equal(globMatches("src/*.ts", "src/nested/a.ts"), false);
  assert.throws(() => globMatches("../**", "src/a.ts"));
});

test("inventory walks every file, ignores VCS ignore lists, and refuses symlink escape", (t) => {
  const { root, write } = fixture(t, {}, { "main.txt": "value", ".gitignore": "ignored.txt\n" });
  assert.ok(inventory(root).files.includes("main.txt"));
  write("ignored.txt", "untracked");
  assert.ok(inventory(root).files.includes("ignored.txt"));
  symlinkSync(join(root, "main.txt"), join(root, "linked.txt"));
  assert.throws(() => safePath(root, "linked.txt"));
  assert.ok(inventory(root).problems.some((item) => item.rule === "inventory.unsafe"));
});

test("portable core passes without language dependencies or a package manifest and is deterministic", async (t) => {
  const { root } = fixture(t, { files: { required: ["README.md"] } }, { "README.md": "# Example\n" });
  const first = await checkRepository({ root }); const second = await checkRepository({ root });
  assert.equal(first.exitCode, 0, JSON.stringify(first.diagnostics));
  assert.equal(canonical(first), canonical(second));
  assert.equal(first.checks.find((item) => item.id === "javascript").status, "not-applicable");
  assert.equal(first.identity.tools.node, process.versions.node);
});

test("missing required files fail, incomplete status cannot be overwritten by report metadata", async (t) => {
  const { root } = fixture(t, { files: { required: ["missing.txt"] } });
  assert.equal((await checkRepository({ root })).exitCode, 1);
  assert.equal(report([{ rule: "x", path: ".", message: "failed", status: "incomplete" }], { exitCode: 0, status: "pass" }).exitCode, 2);
});

test("missing language pack and mutation during a check cannot report success", async (t) => {
  const { root, write } = fixture(t, { projects: [{ root: ".", profile: "typescript" }] }, { "main.ts": "export const value = 1;\n", ".prettierignore": "" });
  const missing = await checkRepository({ root, loadJavascript: async () => { throw new Error("unavailable"); } });
  assert.equal(missing.exitCode, 2);
  const changed = await checkRepository({ root, loadJavascript: async () => ({ rules: () => [], check: () => { write("main.ts", "export const value = 2;\n"); return { diagnostics: [] }; } }) });
  assert.ok(changed.diagnostics.some((item) => item.rule === "run.mutated"));
  assert.equal(changed.exitCode, 2);
});

test("exceptions are exact, bounded, nonoverlapping and cannot hide incomplete checks", () => {
  const diagnostics = [{ rule: "files.names", path: "Bad.txt", message: "name" }];
  const rules = [{ id: "files.names" }, { id: "run.failed", suppressible: false }];
  const exception = { id: "legacy", files: ["Bad.txt"], rules: ["files.names"], reason: "pending migration", max: 1 };
  assert.equal(applyExceptions(diagnostics, [exception], rules).diagnostics.length, 0);
  assert.ok(applyExceptions([], [exception], rules).diagnostics.some((item) => item.rule === "exceptions.stale"));
  assert.ok(applyExceptions(diagnostics, [exception, { ...exception, id: "duplicate" }], rules).diagnostics.some((item) => item.rule === "exceptions.overlap"));
  assert.ok(applyExceptions(diagnostics, [{ ...exception, expires: "2020-01-01" }], rules, "2026-11-05").diagnostics.some((item) => item.rule === "exceptions.expired"));
  assert.equal(applyExceptions([{ ...diagnostics[0], status: "incomplete" }], [exception], rules).suppressed.length, 0);
  assert.ok(applyExceptions([], [{ ...exception, rules: ["run.failed"] }], rules).diagnostics.some((item) => item.rule === "exceptions.invalid"));
});

test("command runner distinguishes findings, missing executables, timeouts and wrong versions", async (t) => {
  const { root } = fixture(t);
  assert.equal((await run([process.execPath, "-e", "process.stdout.write('ok')"], { cwd: root })).stdout, "ok");
  assert.ok((await run(["plumb-test-missing-executable"], { cwd: root })).error);
  assert.match((await run([process.execPath, "-e", "setInterval(()=>{},100)"], { cwd: root, timeout: 50 })).error, /Timed out/);
  const result = await executeSteps({ root, config: { tools: { versions: { native: "9.0.0" } } } }, [{ id: "native.check", tool: "native", cwd: root, command: ["native"], versionCommand: ["native", "--version"] }], async () => ({ code: 0, stdout: "1.0.0", stderr: "" }));
  assert.equal(result.diagnostics[0].status, "incomplete");
});

test("CLI rejects missing or unknown flags, init does not clobber, fix never rewrites expectations", async (t) => {
  const { root } = fixture(t);
  assert.equal((await cli(["check", "--root", root, "--task"])).code, 2);
  assert.equal((await cli(["check", "--root", root, "--skip"])).code, 2);
  assert.equal((await cli(["init", "--root", root])).code, 2);
  const before = readFileSync(join(root, "plumb.json"), "utf8");
  const fixed = await cli(["fix", "--root", root]);
  assert.equal(fixed.code, 0, JSON.stringify(fixed.body));
  assert.equal(readFileSync(join(root, "plumb.json"), "utf8"), before);
  assert.equal(fixed.body.status, "pass");
});

test("approved external policy is applied instead of candidate policy", async (t) => {
  const candidate = fixture(t);
  const trusted = fixture(t, { files: { required: ["required.txt"] } });
  const result = await checkRepository({ root: candidate.root, policy: join(trusted.root, "plumb.json") });
  assert.equal(result.exitCode, 1);
  assert.ok(result.diagnostics.some((item) => item.rule === "files.required"));
});

test("accepted debt is disclosed without contradicting check status", async (t) => {
  const { root } = fixture(t, { files: { required: ["pending.txt"] }, exceptions: [{ id: "pending-doc", rules: ["files.required"], files: ["pending.txt"], reason: "tracked documentation migration", max: 1 }] });
  const result = await checkRepository({ root });
  assert.equal(result.exitCode, 0, JSON.stringify(result.diagnostics));
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.checks.find((item) => item.id === "files").status, "pass");
});

test("scope and generation guardrails reject configuration bypasses", () => {
  assert.throws(() => globMatches("{a,b}".repeat(20), "anything"), /256 alternatives/);
  assert.throws(() => definePlumb({ schemaVersion: 1, generated: [{ path: "plumb.json", content: "{}" }] }), /cannot replace policy/);
  assert.throws(() => definePlumb({ schemaVersion: 1, generated: [{ path: "api.surface.json", content: "{}" }] }), /cannot replace policy/);
  assert.throws(() => definePlumb({ schemaVersion: 1, projects: [{ root: ".", profile: "typescript" }, { root: "./", profile: "react" }] }), /Duplicate project/);
  assert.equal(definePlumb({ schemaVersion: 1, docs: { index: "./README.md" } }).docs.index, "README.md");
});

test("timeouts also stop subprocess trees without waiting on inherited pipes", async (t) => {
  const { root } = fixture(t);
  const child = "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'inherit'});setInterval(()=>{},100);";
  const began = Date.now();
  const result = await run([process.execPath, "-e", child], { cwd: root, timeout: 100 });
  assert.match(result.error, /Timed out/);
  assert.ok(Date.now() - began < 5000);
});

test("Ruby build files count as source and require profile coverage", async (t) => {
  for (const file of ["Gemfile", "Rakefile"]) {
    const { root } = fixture(t, { projects: [{ root: ".", profile: "ruby" }] }, { [file]: "require 'rake'\n" });
    assert.equal((await cli(["sync", "--root", root])).code, 0);
    const checked = await checkRepository({ root, execute: async (command) => ({ code: 0, stdout: command.includes("--version") ? "1.0.0" : JSON.stringify({ files: [{ path: file, offenses: [] }], summary: { inspected_file_count: 1 } }), stderr: "" }) });
    assert.equal(checked.exitCode, 0, JSON.stringify(checked.diagnostics));
  }
  const { root } = fixture(t, { preset: "ozlabs" }, { Gemfile: "source 'https://rubygems.org'\n" });
  assert.ok((await checkRepository({ root })).diagnostics.some((item) => item.rule === "projects.uncovered" && item.path === "Gemfile"));
});

test("a nested profile cannot supply all coverage for an otherwise empty parent", async (t) => {
  const { root } = fixture(t, { projects: [{ root: ".", profile: "typescript" }, { root: "a", profile: "react" }] }, { "a/main.tsx": "export const value = 1;\n" });
  const result = await checkRepository({ root, loadJavascript: async () => ({ rules: () => [], check: () => ({ diagnostics: [] }) }) });
  assert.equal(result.exitCode, 2);
  assert.ok(result.diagnostics.some((item) => item.rule === "projects.scope" && item.path === "."));
  assert.ok(!result.diagnostics.some((item) => item.rule === "projects.scope" && item.path === "a"));
});
