import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ESLint } from "eslint";
import { safePath, globMatches } from "@ozlabs/plumb/files";
import { context as repositoryContext } from "@ozlabs/plumb";
import { Analysis } from "../src/analysis.mjs";
import { createConfig, typedRuntime } from "../eslint/index.mjs";
import { createModuleResolver } from "../shared/module-resolver.mjs";

function fixture(t, files, { options = {}, compilerOptions = {}, include = ["src/**/*"] } = {}) {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-typed-lint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const all = { ...files, "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", ...compilerOptions }, include }) };
  for (const [file, source] of Object.entries(all)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); }
  const project = { root: ".", profile: "typescript" }, context = { root, files: Object.keys(all), config: { projects: [project] }, safePath: (file, settings) => safePath(root, file, settings), matches: globMatches, read: (file) => readFileSync(safePath(root, file), "utf8") };
  const analysis = new Analysis(context), runtime = typedRuntime(analysis, project, Object.keys(files));
  const engine = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: createConfig({ root, ...options }, runtime) });
  return { root, analysis, runtime, async lint(file = "src/main.ts") {
    const [result] = await engine.lintText(context.read(file), { filePath: join(root, file) });
    assert.ok(!result.messages.some((item) => item.fatal), JSON.stringify(result.messages));
    return result.messages;
  } };
}

test("real typed lint refuses floating promises including void and custom thenables", async (t) => {
  const source = 'export async function work(): Promise<number> { return 1; }\nwork();\nvoid work();\ninterface Pending { then(ok: () => void, bad: () => void): Pending }\ndeclare const pending: Pending;\npending;\n';
  const found = await fixture(t, { "src/main.ts": source }).lint();
  assert.equal(found.filter((item) => item.ruleId === "@typescript-eslint/no-floating-promises").length, 3);
  const correct = await fixture(t, { "src/main.ts": 'async function work(): Promise<number> { return 1; }\nexport async function read(): Promise<number> { return await work(); }\n' }).lint();
  assert.ok(!correct.some((item) => item.ruleId === "@typescript-eslint/no-floating-promises"));
});

test("real typed rules enforce promise context, unsafe values and complete union switches", async (t) => {
  const source = 'declare const unsafe: any;\ndeclare function task(): Promise<void>;\nexport const value = unsafe.field;\nunsafe();\nexport function read(take: (n: number) => void): string { take(unsafe); if (task()) { return unsafe; } return "ok"; }\nexport function choice(value: "a" | "b"): number { switch (value) { case "a": return 1; default: return 0; } }\nexport async function wait(): Promise<void> { await 1; }\n';
  const found = new Set((await fixture(t, { "src/main.ts": source }).lint()).map((item) => item.ruleId));
  for (const rule of ["no-misused-promises", "no-unsafe-argument", "no-unsafe-assignment", "no-unsafe-call", "no-unsafe-member-access", "no-unsafe-return", "switch-exhaustiveness-check", "await-thenable"]) assert.ok(found.has(`@typescript-eslint/${rule}`), rule);
  const correct = await fixture(t, { "src/main.ts": 'export function choice(value: "a" | "b"): number { switch (value) { case "a": return 1; case "b": return 2; } }\n' }).lint();
  assert.ok(!correct.some((item) => item.ruleId === "@typescript-eslint/switch-exhaustiveness-check"));
});

test("typed scope cannot omit TypeScript and exposes JavaScript without type evidence", async (t) => {
  assert.throws(() => fixture(t, { "src/main.ts": "export const value = 1;\n", "src/omitted.ts": "export const other = 2;\n" }, { include: ["src/main.ts"] }), /outside every configured Program/);
  const files = { "src/main.ts": "export const value = 1;\n", "src/extra.js": "Promise.resolve(1);\n" };
  assert.deepEqual(fixture(t, files).runtime.syntaxOnlyFiles, ["src/extra.js"]);
  const checked = fixture(t, files, { compilerOptions: { allowJs: true } });
  assert.ok(checked.runtime.typedFiles.includes("src/extra.js"));
  assert.ok((await checked.lint("src/extra.js")).some((item) => item.ruleId === "@typescript-eslint/no-floating-promises"));
});

test("real compiler Programs track extended configs, package metadata, local inputs and absent resolution probes", (t) => {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-typed-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "plumb.json": JSON.stringify({ schemaVersion: 1, preset: "portable", projects: [{ root: ".", profile: "typescript" }], exclude: [{ files: ["src/hidden.ts"], reason: "Observed dependency fixture" }] }),
    "tsconfig.json": JSON.stringify({ extends: "./config/base.json", files: ["src/main.ts"] }),
    "config/base.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" } }),
    "src/main.ts": 'import type { External } from "typed-fixture";\nimport { hidden } from "./hidden.js";\nexport const value: External = { value: hidden };\n',
    "src/hidden.ts": "export const hidden = 1;\n",
    "node_modules/typed-fixture/package.json": JSON.stringify({ name: "typed-fixture", types: "index.d.ts" }),
    "node_modules/typed-fixture/index.d.ts": "export interface External { value: number }\n",
  };
  for (const [file, source] of Object.entries(files)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), source); }
  const ctx = repositoryContext({ root }), analysis = new Analysis(ctx), project = ctx.config.projects[0];
  const runtime = typedRuntime(analysis, project, ["src/main.ts"]);
  runtime.programs[0].getSemanticDiagnostics();
  for (const file of ["config/base.json", "src/main.ts", "src/hidden.ts", "node_modules/typed-fixture/package.json", "node_modules/typed-fixture/index.d.ts"]) assert.ok(ctx.compilerInputs.has(file), file);
  assert.equal(analysis.resolver.resolve(join(root, "src/main.ts"), "./later.js", runtime.programs[0].getCompilerOptions()), undefined);
  assert.ok([...ctx.compilerInputs].some(([file, hash]) => file.startsWith("src/later.") && hash === null));
  assert.ok(ctx.compilerDirectories.has("src"));
  writeFileSync(join(root, "src/hidden.ts"), "export const hidden = 2;\n");
  assert.throws(() => analysis.compilerHost({}).readFile(join(root, "src/hidden.ts")), /changed while checking/);
});

test("standalone module resolution uses the same closed source boundary", (t) => {
  const parent = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-resolver-boundary-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "candidate"); mkdirSync(root);
  writeFileSync(join(parent, "outside.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "main.ts"), "export const value = 1;\n");
  const resolver = createModuleResolver(root);
  assert.equal(resolver.resolve(join(root, "main.ts"), "../outside"), undefined);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "../outside.json", files: ["main.ts"] }));
  writeFileSync(join(parent, "outside.json"), JSON.stringify({ compilerOptions: { strict: false } }));
  assert.throws(() => createModuleResolver(root).optionsFor(join(root, "main.ts")), /outside|not found|escapes/i);
});

test("the public preset reports absent type services rather than a syntax-only TS success", async (t) => {
  const { root } = fixture(t, { "src/main.ts": "export const value = 1;\n" });
  const engine = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: createConfig({ root }) });
  const [result] = await engine.lintText("export const value = 1;\n", { filePath: join(root, "src/main.ts") });
  assert.ok(result.messages.some((item) => item.ruleId === "plumb/type-information" && item.messageId === "unresolved"));
});

test("ownership follows aliases, destructuring and static keys without confusing shadows", async (t) => {
  const rows = [{ now: true, owner: ["src/clock.ts"], message: "use clock" }], options = { rules: [{ files: ["src/**"], rules: { "plumb/owners": ["error", { rows }] } }] };
  for (const code of ['const clock = Date; export const time: number = clock.now();', 'const { now: read } = Date; export const time: number = read();', 'const clock = Date; const key = "now"; export const time: number = clock[key]();', 'const box = { clock: Date }; export const time: number = box.clock.now();']) {
    assert.ok((await fixture(t, { "src/main.ts": code }, { options }).lint()).some((item) => item.ruleId === "plumb/owners"), code);
  }
  const shadow = 'export function read(Date: { now(): number }): number { return Date.now(); }\n';
  assert.ok(!(await fixture(t, { "src/main.ts": shadow }, { options }).lint()).some((item) => item.ruleId === "plumb/owners"));
  for (const code of ['const clock = Date; declare const key: string; export const time = clock[key];', 'let clock = Date; clock = Date; export const time: number = clock.now();']) assert.ok((await fixture(t, { "src/main.ts": code }, { options }).lint()).some((item) => item.ruleId === "plumb/owners" && item.messageId === "unresolved"));
});

test("compiler symbol identity follows renamed reexports and refuses same-name spoofing", async (t) => {
  const options = { rules: [{ files: ["src/main.ts"], rules: { "plumb/owners": ["error", { rows: [{ importFrom: "./raw.js", name: "read", owner: ["src/raw.ts"], message: "use adapter" }] }] } }] };
  const files = { "src/raw.ts": "export function read(): number { return 1; }\n", "src/bridge.ts": 'export { read as renamed } from "./raw.js";\n', "src/main.ts": 'import { renamed as load } from "./bridge.js";\nexport const value: number = load();\n' };
  assert.ok((await fixture(t, files, { options }).lint()).some((item) => item.ruleId === "plumb/owners"));
  const shadow = { ...files, "src/main.ts": "function read(): number { return 2; }\nexport const value: number = read();\n" };
  assert.ok(!(await fixture(t, shadow, { options }).lint()).some((item) => item.ruleId === "plumb/owners"));
});

test("error factories are imported symbols and result signatures use the approved type", async (t) => {
  const supporting = { "src/errors.ts": "export function failure(message: string): Error { return new Error(message); }\n", "src/bridge.ts": 'export { failure as failed } from "./errors.js";\n' };
  const options = { errorHandling: { files: ["src/main.ts"], factories: [{ from: "./errors.js", name: "failure" }] } };
  const accepted = { ...supporting, "src/main.ts": 'import { failed as fail } from "./bridge.js";\nexport function read(): never { throw fail("bad"); }\n' };
  assert.ok(!(await fixture(t, accepted, { options }).lint()).some((item) => item.ruleId === "plumb/errors"));
  const rejected = { ...supporting, "src/main.ts": 'function failure(message: string): Error { return new Error(message); }\nexport function read(): never { throw failure("bad"); }\n' };
  assert.ok((await fixture(t, rejected, { options }).lint()).some((item) => item.ruleId === "plumb/errors" && item.messageId === "factory"));
  const resultOptions = { errorHandling: { files: ["src/main.ts"], result: { from: "./result.js", name: "Result" } } };
  const result = { "src/result.ts": "export type Result<T> = { ok: true; value: T } | { ok: false; error: Error };\n", "src/main.ts": 'import type { Result } from "./result.js";\nexport function read(): Result<number> { return { ok: true, value: 1 }; }\n' };
  assert.ok(!(await fixture(t, result, { options: resultOptions }).lint()).some((item) => item.ruleId === "plumb/errors"));
  assert.ok((await fixture(t, { ...result, "src/main.ts": "export function read(): number { return 1; }\n" }, { options: resultOptions }).lint()).some((item) => item.ruleId === "plumb/errors" && item.messageId === "result"));
});

test("empty catches and non-Error throws fail; detached work requires a typed approved wrapper", async (t) => {
  const source = 'export function read(): void { try { throw "bad"; } catch { /* deliberately swallowed */ } }\n';
  const caught = await fixture(t, { "src/main.ts": source }).lint();
  assert.ok(caught.some((item) => item.ruleId === "plumb/errors" && item.messageId === "empty"));
  assert.ok(caught.some((item) => item.ruleId === "@typescript-eslint/only-throw-error"));
  const options = { errorHandling: { files: ["src/main.ts"], background: [{ from: "./background.js", name: "run" }] } };
  const supporting = { "src/background.ts": "export declare function run(work: () => Promise<void>): void;\n" };
  const accepted = { ...supporting, "src/main.ts": 'import { run as schedule } from "./background.js";\nasync function work(): Promise<void> { await Promise.resolve(); }\nschedule(work);\n' };
  assert.ok(!(await fixture(t, accepted, { options }).lint()).some((item) => item.ruleId === "plumb/errors"));
  const rejected = { ...supporting, "src/main.ts": 'async function work(): Promise<void> { await Promise.resolve(); }\nwork().catch((error: unknown) => { if (error instanceof Error) { throw error; } throw new Error("unknown"); });\n' };
  assert.ok((await fixture(t, rejected, { options }).lint()).some((item) => item.ruleId === "plumb/errors" && item.messageId === "background"));
});
