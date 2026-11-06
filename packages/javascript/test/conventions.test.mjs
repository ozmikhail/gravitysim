import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { globMatches, safePath } from "@ozlabs/plumb/files";
import { Analysis } from "../src/analysis.mjs";
import { checkConventions } from "../src/conventions.mjs";

const compiler = { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, allowJs: true, paths: { "@shared/*": ["./shared/*"] } } };
function fixture(t, sources, role = {}, changes = {}) {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-js-conventions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = { "tsconfig.json": JSON.stringify(compiler), ...sources };
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
  const config = { preset: "portable", projects: [], exclude: [], conventions: { files: ["src/**"], roles: [{ id: "source", files: ["src/**"], ...role }] }, ...changes };
  return { root, config, allFiles: Object.keys(files).sort(), files: Object.keys(files).filter((path) => !config.exclude.some((entry) => globMatches(entry.files, path))).sort(),
    matches: globMatches, safePath: (path, options) => safePath(root, path, options), read: (path) => readFileSync(safePath(root, path), "utf8") };
}
const shape = (select, count, id = "shape") => ({ javascript: { nodes: [{ id, select, count }] } });
const typed = { javascript: { assignable: [{ id: "handler", export: "run", contract: { file: "contracts.ts", symbol: "Handler" }, tsconfig: "tsconfig.json" }] } };
const handler = "export interface Handler { (value: number): string }\n";
const check = (context) => checkConventions(context, new Analysis(context));

test("role import boundaries use literal specifiers, type imports and compiler-resolved aliases", (t) => {
  const context = fixture(t, {
    "src/main.ts": 'import { value } from "@shared/value.js"; import type { Data } from "../shared/types.js"; export { value };',
    "shared/value.ts": "export const value = 1;", "shared/types.ts": "export interface Data { value: number }",
  }, { imports: { allow: ["shared/**"], deny: ["node:fs"] } });
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "src/main.ts"), 'import "node:fs"; import type { Data } from "../shared/types.js";');
  context.config.conventions.roles[0].imports.deny.push("shared/types.ts");
  const diagnostics = check(context);
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every((item) => item.rule === "conventions.imports"));
  assert.ok(diagnostics.some((item) => item.message.includes("node:fs")));
  assert.ok(diagnostics.some((item) => item.message.includes("shared/types.ts")));
});

test("computed, missing and excluded local dependencies are incomplete", (t) => {
  const context = fixture(t, { "src/main.ts": "export const load = (name: string) => import(name);", "shared/value.ts": "export const value = 1;" }, { imports: { allow: ["shared/**"] } });
  assert.equal(check(context)[0].status, "incomplete");
  writeFileSync(join(context.root, "src/main.ts"), 'import "./missing.js";');
  assert.match(check(context)[0].message, /Cannot resolve local dependency/);
  writeFileSync(join(context.root, "src/main.ts"), 'import "../shared/value.js";');
  context.files = context.files.filter((path) => path !== "shared/value.ts");
  assert.match(check(context)[0].message, /outside the checked inventory/);
});

test("allow-empty import policy is meaningful and forbids every observed dependency", (t) => {
  const context = fixture(t, { "src/main.ts": "export const value = 1;" }, { imports: { allow: [] } });
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "src/main.ts"), 'import "node:path";');
  assert.equal(check(context)[0].rule, "conventions.imports");
});

test("resolved export names include aliases and type reexports", (t) => {
  const context = fixture(t, {
    "src/main.ts": 'export { implementation as run } from "../shared/implementation.js"; export type { Version } from "../shared/implementation.js";',
    "shared/implementation.ts": "export const implementation = 1; export type Version = string;",
  }, { exports: { require: ["run", "Version"], allow: ["run", "Version"], name: "^(run|Version)$" } });
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "src/main.ts"), "export const extra = 1;");
  const diagnostics = check(context);
  assert.equal(diagnostics.filter((item) => item.rule === "conventions.exports").length, 3);
  assert.ok(diagnostics.some((item) => /requires export run/.test(item.message)));
  assert.ok(diagnostics.some((item) => /does not allow export extra/.test(item.message)));
});

test("missing reexports and unsupported CommonJS exports cannot claim a complete shape", (t) => {
  const context = fixture(t, { "src/main.ts": 'export * from "./missing.js";' }, { exports: { allow: [] } });
  assert.equal(check(context)[0].status, "incomplete");
  const commonjs = fixture(t, { "src/main.cjs": "exports.run = () => 1;" }, { exports: { require: ["run"] } });
  assert.ok(check(commonjs).some((item) => item.rule === "conventions.analysis" && item.status === "incomplete" && /CommonJS/.test(item.message)));
});

test("positive selectors distinguish exported aliases, nested members and destructured bindings", (t) => {
  const context = fixture(t, { "src/main.ts": "function implementation() { return 1; } export { implementation as run }; class Owner { execute() {} } const { one, two } = { one: 1, two: 2 }; export { one };" }, { javascript: { nodes: [
    { id: "public-function", select: { kinds: ["function"], names: ["implementation"], exported: true, topLevel: true }, count: { min: 1, max: 1 } },
    { id: "nested-method", select: { kinds: ["method"], names: ["execute"], exported: false, topLevel: false }, count: { min: 1, max: 1 } },
    { id: "bindings", select: { kinds: ["variable"], names: ["one", "two"], topLevel: true }, count: { min: 2, max: 2 } },
    { id: "private-binding", select: { kinds: ["variable"], names: ["two"], exported: false }, count: { min: 1, max: 1 } },
  ] } });
  assert.deepEqual(check(context), []);
});

test("shape counts reject missing declarations and excess selected declarations", (t) => {
  const context = fixture(t, { "src/main.ts": "export function first() {} export function second() {}" }, shape({ kinds: ["function"], exported: true, topLevel: true }, { min: 1, max: 1 }));
  assert.match(check(context)[0].message, /matched 2 declarations/);
  writeFileSync(join(context.root, "src/main.ts"), "export const value = 1;");
  assert.match(check(context)[0].message, /matched 0 declarations/);
  context.config.conventions.roles[0].javascript.nodes[0].count = { max: 0 };
  assert.deepEqual(check(context), []);
});

test("nested declarations cannot satisfy a top-level positive requirement", (t) => {
  const context = fixture(t, { "src/main.ts": "export function outer() { function needed() {} }" }, shape({ kinds: ["function"], names: ["needed"], topLevel: true }, { min: 1 }));
  assert.equal(check(context)[0].rule, "conventions.nodes");
  context.config.conventions.roles[0].javascript.nodes[0].select.topLevel = false;
  assert.deepEqual(check(context), []);
});

test("unsupported computed declaration names and invalid syntax are incomplete", (t) => {
  const context = fixture(t, { "src/main.ts": "export class Source { [Symbol.iterator]() {} }" }, shape({ kinds: ["method"], names: ["execute"] }, { min: 1 }));
  assert.match(check(context)[0].message, /computed declaration name/);
  writeFileSync(join(context.root, "src/main.ts"), "export function {");
  assert.ok(check(context).every((item) => item.status === "incomplete" && item.suppressible === false));
});

test("JavaScript-only role semantics explicitly refuse non-JavaScript source", (t) => {
  const context = fixture(t, { "src/main.py": "value = 1\n" }, { exports: { allow: [] } });
  assert.match(check(context)[0].message, /JS\/TS source/);
  assert.equal(check(context)[0].status, "incomplete");
});

test("typed export contracts use actual strict compiler assignability", (t) => {
  const context = fixture(t, { "src/main.ts": "export const run = (value: number): string => String(value);", "contracts.ts": handler }, typed);
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "src/main.ts"), "export const run = (value: number): number => value;");
  const diagnostics = check(context);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, "conventions.types");
  assert.match(diagnostics[0].message, /not assignable to Handler/);
});

test("typed structural objects and aliased value exports can satisfy a declared interface", (t) => {
  const context = fixture(t, { "src/main.ts": "const implementation = { execute(value: number): string { return String(value); } }; export { implementation as run };", "contracts.ts": "export interface Handler { execute(value: number): string }" }, typed);
  assert.deepEqual(check(context), []);
});

test("missing and type-only value exports are ordinary contract violations", (t) => {
  const context = fixture(t, { "src/main.ts": "export const other = 1;", "contracts.ts": handler }, typed);
  assert.equal(check(context)[0].rule, "conventions.types");
  assert.match(check(context)[0].message, /value export run is missing/);
  writeFileSync(join(context.root, "src/main.ts"), "export type run = (value: number) => string;");
  assert.match(check(context)[0].message, /type-only export/);
});

test("any, unknown, never and uninstantiated generic exports cannot prove typed contracts", (t) => {
  for (const source of ["export const run: any = 1;", "export const run: unknown = 1;", "export const run = null as never;", "export function run<T>(value: T): T { return value; }"]) {
    const context = fixture(t, { "src/main.ts": source, "contracts.ts": handler }, typed);
    const diagnostics = check(context);
    assert.ok(diagnostics.some((item) => item.rule === "conventions.analysis" && item.status === "incomplete"), source);
  }
  const nested = fixture(t, { "src/main.ts": "export const run = { execute: null as any };", "contracts.ts": "export interface Handler { execute(value: number): string }" }, typed);
  assert.match(check(nested)[0].message, /unsafe or unevaluated type/);
});

test("missing contract symbols, compiler errors and weakened compiler settings are incomplete", (t) => {
  const context = fixture(t, { "src/main.ts": "export const run = (value: number): string => String(value);", "contracts.ts": "export interface Other { value: string }" }, typed);
  assert.match(check(context)[0].message, /must be an exported declared type/);
  writeFileSync(join(context.root, "contracts.ts"), handler);
  writeFileSync(join(context.root, "src/main.ts"), 'import "./missing.js"; export const run = (value: number): string => String(value);');
  assert.match(check(context)[0].message, /compiler errors/);
  writeFileSync(join(context.root, "src/main.ts"), "export const run = (value: number): string => String(value);");
  writeFileSync(join(context.root, "tsconfig.json"), JSON.stringify({ ...compiler, compilerOptions: { ...compiler.compilerOptions, strictNullChecks: false } }));
  assert.match(check(context)[0].message, /strictNullChecks conflicts/);
});

test("a typed contract cannot add excluded or unconfigured source to its Program", (t) => {
  const context = fixture(t, { "src/main.ts": "export const run = (value: number): string => String(value);", "contracts.ts": handler }, typed);
  writeFileSync(join(context.root, "tsconfig.json"), JSON.stringify({ ...compiler, files: ["contracts.ts"] }));
  assert.match(check(context)[0].message, /must include both/);
  writeFileSync(join(context.root, "tsconfig.json"), JSON.stringify(compiler));
  context.files = context.files.filter((path) => path !== "contracts.ts");
  assert.ok(check(context).some((item) => item.status === "incomplete" && /absent from the checked inventory/.test(item.message)));
});

test("compiler-backed shape evidence must match the shared observed source", (t) => {
  const context = fixture(t, { "src/main.ts": "export function implementation() {}" }, shape({ kinds: ["function"], exported: true }, { min: 1 }));
  const actual = context.read;
  context.readCompilerInput = (path, { allowMissing = false } = {}) => {
    try { return actual(path); }
    catch (error) { if (allowMissing && error.code === "ENOENT") return null; throw error; }
  };
  context.read = (path) => path === "src/main.ts" ? "export function altered() {}" : actual(path);
  assert.match(check(context)[0].message, /different source text/);
});
