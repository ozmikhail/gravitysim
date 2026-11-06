import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { main } from "../src/cli.mjs";
import { definePlumb } from "../src/config.mjs";
import { checkRepository, context } from "../src/engine.mjs";
import { safePath } from "../src/files.mjs";
import { executeSteps } from "../src/process.mjs";

const policy = { schemaVersion: 1, preset: "portable", javascript: {} };
async function fixture(contents, verify) {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-adversarial-test-"));
  try {
    for (const [path, content] of Object.entries(contents)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    await verify(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const fakePack = (action) => async () => ({ rules: () => [], check: async (ctx) => { await action(ctx); return { diagnostics: [] }; } });
const observingPack = (action) => async () => ({ rules: () => [], check: async (ctx, plan) => {
  await action(ctx);
  return { diagnostics: [], coverage: plan.map((entry) => ({ id: entry.id, checkedFiles: entry.files, status: "pass" })) };
} });

test("a newly created unsafe path cannot disappear from post-check verification", { skip: process.platform === "win32" }, async () => {
  await fixture({ "plumb.json": JSON.stringify(policy), "data.txt": "original" }, async (root) => {
    const result = await checkRepository({ root, loadJavascript: fakePack(() => symlinkSync(join(root, "data.txt"), join(root, "new-link"))) });
    assert.equal(result.status, "incomplete");
    assert.ok(result.diagnostics.some(({ rule }) => ["run.mutated", "inventory.unsafe"].includes(rule)));
  });
});

test("the candidate policy remains protected from tool mutations", async () => {
  await fixture({ "plumb.json": JSON.stringify(policy), "data.txt": "original" }, async (root) => {
    const result = await checkRepository({ root, loadJavascript: fakePack(() => writeFileSync(join(root, "plumb.json"), '{"schemaVersion":1,"preset":"portable"}')) });
    assert.equal(result.status, "incomplete");
    assert.ok(result.diagnostics.some(({ rule }) => rule === "run.mutated"));
  });
});

test("compiler reads bind dependency bytes and missing resolution probes to run identity", async () => {
  await fixture({ "plumb.json": JSON.stringify(policy), "src/index.ts": "export const value = 1;", "node_modules/example/index.d.ts": "export const value: number;" }, async (root) => {
    const inspect = observingPack((ctx) => {
      assert.equal(ctx.readCompilerInput("node_modules/example/index.d.ts"), "export const value: number;");
      assert.equal(ctx.readCompilerInput("node_modules/example/missing.d.ts", { allowMissing: true }), null);
    });
    const first = await checkRepository({ root, loadJavascript: inspect });
    assert.equal(first.exitCode, 0, JSON.stringify(first.diagnostics));
    assert.match(first.identity.compilerInputs, /^[a-f0-9]{64}$/);
    writeFileSync(join(root, "node_modules/example/index.d.ts"), "export const value: string;");
    const second = await checkRepository({ root, loadJavascript: observingPack((ctx) => {
      ctx.readCompilerInput("node_modules/example/index.d.ts"); ctx.readCompilerInput("node_modules/example/missing.d.ts", { allowMissing: true });
    }) });
    assert.equal(second.exitCode, 0); assert.notEqual(first.identity.compilerInputs, second.identity.compilerInputs);
  });
});

test("changed compiler inputs and newly appearing dependency paths invalidate the same run", async () => {
  for (const missing of [false, true]) await fixture({ "plumb.json": JSON.stringify(policy), "src/index.ts": "export const value = 1;", "node_modules/example/index.d.ts": "export const value: number;" }, async (root) => {
    const path = `node_modules/example/${missing ? "new" : "index"}.d.ts`;
    const result = await checkRepository({ root, loadJavascript: observingPack((ctx) => {
      ctx.readCompilerInput(path, { allowMissing: true }); writeFileSync(join(root, path), "export const changed: string;");
    }) });
    assert.equal(result.exitCode, 2); assert.ok(result.diagnostics.some((item) => item.rule === "run.mutated"));
  });
});

test("compiler directory observations catch dependency inventory drift", async () => {
  await fixture({ "plumb.json": JSON.stringify(policy), "src/index.ts": "export const value = 1;", "node_modules/example/index.d.ts": "export const value: number;" }, async (root) => {
    const result = await checkRepository({ root, loadJavascript: observingPack((ctx) => {
      assert.deepEqual(ctx.readCompilerDirectory("node_modules/example"), [{ name: "index.d.ts", kind: "file" }]);
      assert.equal(ctx.readCompilerDirectory("node_modules/absent", { allowMissing: true }), null);
      writeFileSync(join(root, "node_modules/example/new.d.ts"), "export const other: number;");
    }) });
    assert.equal(result.exitCode, 2); assert.ok(result.diagnostics.some((item) => item.rule === "run.mutated"));
  });
});

test("compiler readers allow dependency inputs without widening ordinary source or metadata access", async () => {
  await fixture({ "plumb.json": JSON.stringify(policy), "node_modules/example/index.d.ts": "export {};" }, async (root) => {
    const ctx = context({ root });
    assert.throws(() => ctx.read("node_modules/example/index.d.ts"), /Reserved/);
    assert.throws(() => ctx.readCompilerInput("../escape", { allowMissing: true }), /escapes/);
    assert.throws(() => ctx.readCompilerInput(".git/config", { allowMissing: true }), /Reserved/);
    if (process.platform !== "win32") {
      symlinkSync(join(root, "plumb.json"), join(root, "node_modules/example/link.json"));
      assert.throws(() => ctx.readCompilerInput("node_modules/example/link.json"), /Symbolic/);
    }
  });
});

test("an external approved policy remains protected from tool mutations", async () => {
  await fixture({ "approved.json": JSON.stringify(policy), "candidate/data.txt": "original" }, async (root) => {
    const approved = join(root, "approved.json");
    const result = await checkRepository({ root: join(root, "candidate"), policy: approved, loadJavascript: fakePack(() => writeFileSync(approved, '{"schemaVersion":1,"preset":"portable"}')) });
    assert.equal(result.status, "incomplete");
    assert.ok(result.diagnostics.some(({ rule }) => rule === "run.mutated"));
  });
});

test("tool versions are probed for distinct project environments", async () => {
  const ctx = { root: ".", config: { tools: { versions: { rubocop: "1.0.0" } } } };
  const steps = ["one", "two"].map((name) => ({ id: `ruby.lint:${name}`, rule: "ruby.lint", tool: "rubocop", cwd: name, command: ["bundle", "exec", "rubocop", "check"], versionCommand: ["bundle", "exec", "rubocop", "--version"] }));
  const ran = [];
  const execute = async (command, { cwd }) => {
    if (command.at(-1) === "--version") return { code: 0, stdout: cwd === "one" ? "1.0.0" : "2.0.0", stderr: "" };
    ran.push(cwd);
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await executeSteps(ctx, steps, execute);
  assert.ok(result.diagnostics.some(({ rule }) => rule === "tools.version"));
  assert.deepEqual(ran, ["one"]);
});

test("a mismatched cached version cannot allow a later tool invocation", async () => {
  const ctx = { root: ".", config: { tools: { versions: { rubocop: "1.0.0" } } } };
  const steps = ["one", "two"].map((id) => ({ id, rule: "ruby.lint", tool: "rubocop", cwd: ".", command: ["rubocop", "--autocorrect"], versionCommand: ["rubocop", "--version"] }));
  let ran = 0;
  const result = await executeSteps(ctx, steps, async (command) => {
    if (command.at(-1) === "--version") return { code: 0, stdout: "2.0.0", stderr: "" };
    ran++;
    return { code: 0, stdout: "", stderr: "" };
  });
  assert.ok(result.diagnostics.some(({ rule }) => rule === "tools.version"));
  assert.equal(ran, 0);
});

test("an unobserved tool version pin cannot silently pass", async () => {
  await fixture({ "plumb.json": JSON.stringify({ schemaVersion: 1, preset: "portable", tools: { versions: { typoed_tool_name: "1.0.0" } } }) }, async (root) => {
    const result = await checkRepository({ root });
    assert.equal(result.status, "incomplete");
    assert.ok(result.diagnostics.some(({ rule }) => ["config.invalid", "tools.version", "tools.missing"].includes(rule)));
  });
});

test("snapshot destinations cannot overwrite source or repository metadata", () => {
  for (const snapshot of ["src/main.ts", "package.json", ".git/api.surface.json", "node_modules/api.surface.json"]) {
    assert.throws(() => definePlumb({ schemaVersion: 1, projects: [{ root: ".", profile: "typescript", surface: { snapshot } }] }), /snapshot|surface|reserved|metadata|inside/i, snapshot);
  }
  assert.doesNotThrow(() => definePlumb({ schemaVersion: 1, projects: [{ root: ".", profile: "typescript", surface: { snapshot: "api.surface.json" } }] }));
});

test("safePath excludes repository metadata even when the directory exists", async () => {
  await fixture({ ".git/config": "untouched", "node_modules/tool.js": "untouched" }, async (root) => {
    assert.throws(() => safePath(root, ".git/config"), /reserved|metadata|unsupported/i);
    assert.throws(() => safePath(root, "node_modules/tool.js"), /reserved|metadata|unsupported/i);
    assert.equal(readFileSync(join(root, ".git/config"), "utf8"), "untouched");
  });
});

test("native command configuration errors are incomplete rather than violations", async () => {
  const result = await executeSteps({ root: ".", config: {} }, [{ id: "ruby.lint:.", rule: "ruby.lint", command: ["rubocop"], cwd: "." }], async () => ({ code: 2, stdout: "", stderr: "unknown option" }));
  assert.equal(result.checks[0].status, "incomplete");
  assert.equal(result.diagnostics[0].rule, "ruby.lint");
});
