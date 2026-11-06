import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import ts from "typescript";
import { canonical } from "@ozlabs/plumb/files";
import { check, snapshot } from "../src/index.mjs";
import { surfaceSnapshotIsValid } from "../src/exports.mjs";

const fixture = (t, source, { exports = "./src/index.ts", compiler = {}, signatures = true, root: projectRoot = "." } = {}) => {
  const parent = process.env.PLUMB_TEST_TMP ?? tmpdir(); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "plumb-signatures-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = (file) => projectRoot === "." ? file : `${projectRoot}/${file}`;
  const files = {
    [local("tsconfig.json")]: JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2022", strict: true, types: [], ...compiler }, include: ["src/**/*"] }),
    [local("package.json")]: JSON.stringify({ name: "signature-fixture", version: "1.0.0", type: "module", exports }),
    ...Object.fromEntries(Object.entries(source).map(([file, text]) => [local(file), text])),
  };
  const context = { root, files: Object.keys(files).filter((file) => !file.split("/").includes("node_modules")), mode: "check", config: { preset: "portable", contracts: {}, projects: [{ root: projectRoot, profile: "typescript", surface: { snapshot: "api.surface.json", signatures } }] } };
  const write = (file, text) => { const path = local(file); mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  for (const [file, text] of Object.entries(files)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
  const proposal = () => snapshot(context)[0];
  const value = () => JSON.parse(proposal().content);
  const accept = () => { const current = proposal(); writeFileSync(join(root, current.path), current.content); if (!context.files.includes(current.path)) context.files.push(current.path); return current.content; };
  return { context, root, write, proposal, value, accept };
};
const declarations = (value) => Object.values(value.signatures).map((entry) => entry.declaration).join("\n");
const tree = (root, prefix = "") => readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  return entry.isDirectory() ? tree(root, path) : [[path, readFileSync(join(root, path)).toString("base64")]];
});
const changed = (context) => {
  const diagnostics = check(context);
  assert.equal(diagnostics.some((item) => item.status === "incomplete"), false, JSON.stringify(diagnostics));
  assert.ok(diagnostics.some((item) => item.rule === "exports.surface"), JSON.stringify(diagnostics));
};

test("real declaration emission retains overloads, generics, public/protected members and full large types without writing", (t) => {
  const fields = Array.from({ length: 80 }, (_, index) => `field${index}: string;`).join("\n");
  const project = fixture(t, { "src/index.ts": `
    export interface Options<T extends string | number = string> { readonly value: T; label?: string; }
    export interface Large { ${fields} }
    export function parse(value: string): string;
    export function parse(value: number): number;
    export function parse(value: string | number): string | number { return value; }
    export class Store<T extends string | number = string> {
      private secret = 0;
      constructor(public readonly key: string) {}
      protected narrow(value: T): T { this.secret++; return value; }
      read(value: T): Options<T> { return { value: this.narrow(value) }; }
    }
  ` });
  const before = tree(project.root), value = project.value(), text = declarations(value);
  assert.equal(value.schemaVersion, 2); assert.equal(value.compiler.typescript, ts.version);
  assert.equal(surfaceSnapshotIsValid(value), true);
  assert.match(text, /parse\(value: string\): string/); assert.match(text, /parse\(value: number\): number/);
  assert.ok(text.indexOf("parse(value: string)") < text.indexOf("parse(value: number)"));
  assert.match(text, /extends string \| number = string/); assert.match(text, /readonly value: T/);
  assert.match(text, /label\?: string/); assert.match(text, /protected narrow\(value: T\): T/);
  assert.match(text, /constructor\(key: string\)/); assert.match(text, /field79: string/);
  assert.doesNotMatch(text, /secret|this\.|return value|\.\.\. \d+ more/);
  assert.match(text, /#__plumb_private/);
  assert.deepEqual(tree(project.root), before);
  assert.equal(existsSync(join(project.root, "api.surface.json")), false);
  assert.equal(existsSync(join(project.root, ".plumb-signature-output")), false);
});

test("same export names with changed parameter, return or member types refuse the approved signature snapshot", (t) => {
  const project = fixture(t, { "src/index.ts": "export interface Options { readonly name: string; }\nexport function read(value: Options): string { return value.name; }\n" });
  project.accept(); assert.deepEqual(check(project.context), []);
  project.write("src/index.ts", "export interface Options { readonly name: number; }\nexport function read(value: Options): number { return value.name; }\n");
  changed(project.context);
  project.accept(); assert.deepEqual(check(project.context), []);
});

test("implementation edits, private detail and unrelated dependency exports do not change signatures", (t) => {
  const project = fixture(t, {
    "src/index.ts": 'export { Store } from "./store.js"; export type { Public as Options } from "./types.js";',
    "src/store.ts": 'export class Store { private hidden(): string { return "before"; } value(): number { return this.hidden().length; } }',
    "src/types.ts": "export interface Public { name: string; } export function internal(value: number): number { return value; }",
  });
  const before = project.value();
  assert.doesNotMatch(declarations(before), /internal|hidden|before/);
  project.write("src/store.ts", 'export class Store { private renamed(): string { return "different implementation"; } value(): number { return this.renamed().length + 1; } }');
  project.write("src/types.ts", "export interface Public { name: string; } export function internal(value: string): string { return value; }");
  assert.equal(canonical(project.value()), canonical(before));
});

test("reachable transitive types, renamed reexports and namespace public types are retained", (t) => {
  const project = fixture(t, {
    "src/index.ts": 'export { identity as select } from "./entry.js"; export * as model from "./model.js";',
    "src/entry.ts": 'import type { Public } from "./model.js"; export function identity<T extends Public>(value: T): T { return value; }',
    "src/model.ts": 'import type { Detail } from "./detail.js"; export interface Public { readonly detail: Detail; }',
    "src/detail.ts": "export interface Detail { size: number; } export interface Unrelated { hidden: boolean; }",
  });
  const value = project.value(), text = declarations(value);
  assert.ok(value.exports["."].includes("select")); assert.ok(value.exports["."].includes("model"));
  assert.match(text, /Detail/); assert.match(text, /size: number/); assert.doesNotMatch(text, /Unrelated|hidden: boolean/);
  assert.ok(value.signatures["./src/detail.ts"]);
  project.accept(); project.write("src/detail.ts", "export interface Detail { size: string; } export interface Unrelated { hidden: boolean; }");
  changed(project.context);
});

test("dependency declarations are resolved, scoped and bound without exposing install paths", (t) => {
  const project = fixture(t, {
    "src/index.ts": 'export type { Public } from "provider";',
    "node_modules/provider/package.json": JSON.stringify({ name: "provider", version: "1.0.0", types: "index.d.ts" }),
    "node_modules/provider/index.d.ts": "export interface Public { value: string; } export interface Hidden { internal: boolean; }",
  });
  const before = project.value(), text = declarations(before);
  assert.ok(before.signatures["package:provider@1.0.0/index.d.ts"]);
  assert.match(text, /value: string/); assert.doesNotMatch(text, /Hidden|internal/);
  assert.ok(!JSON.stringify(before).includes(project.root));
  project.write("node_modules/provider/index.d.ts", "export interface Public { value: string; } export interface Hidden { internal: number; }");
  assert.equal(canonical(project.value()), canonical(before));
  project.accept(); project.write("node_modules/provider/index.d.ts", "export interface Public { value: number; } export interface Hidden { internal: number; }");
  changed(project.context);
});

test("conditional targets and their precedence are distinct parts of the signature contract", (t) => {
  const map = { ".": { types: "./src/types.d.ts", default: "./src/index.ts" } };
  const project = fixture(t, { "src/index.ts": "export const value: number = 1;", "src/types.d.ts": "export declare const value: number;" }, { exports: map });
  const value = project.value();
  assert.equal(value.targets[". [types]"].module, "./src/types.d.ts");
  assert.equal(value.targets[". [default]"].module, "./src/index.ts");
  assert.notDeepEqual(value.targets[". [types]"].priority, value.targets[". [default]"].priority);
  project.accept();
  project.write("package.json", JSON.stringify({ name: "signature-fixture", version: "1.0.0", type: "module", exports: { ".": { default: "./src/index.ts", types: "./src/types.d.ts" } } }));
  changed(project.context);
});

test("signature output is stable across checkout locations and nested project roots", (t) => {
  const files = { "src/index.ts": "export function identity<T>(value: T): T { return value; }" };
  const first = fixture(t, files), second = fixture(t, files, { root: "a" });
  assert.equal(canonical(first.value()), canonical(second.value()));
  assert.equal(second.proposal().path, "a/api.surface.json");
});

test("typed JavaScript and declaration-only entries produce real declaration contracts", (t) => {
  const javascript = fixture(t, { "src/index.js": "/** @param {string} value @returns {number} */\nexport function size(value) { return value.length; }" }, { exports: "./src/index.js", compiler: { allowJs: true } });
  assert.match(declarations(javascript.value()), /size\(value: string\): number/);
  const declaration = fixture(t, { "src/index.d.ts": "export interface Value { readonly size: number; }" }, { exports: "./src/index.d.ts" });
  assert.match(declarations(declaration.value()), /readonly size: number/);
});

test("unresolved, invalid, excluded or any public type evidence is incomplete rather than an accepted snapshot", (t) => {
  for (const text of ["export type Broken = Missing;", "export function broken(value: number): string { return value; }", "export function unsafe(value: any): any { return value; }", 'export type { Missing } from "missing-provider";']) {
    const project = fixture(t, { "src/index.ts": text });
    assert.throws(project.proposal);
    assert.ok(check(project.context).some((item) => item.status === "incomplete"));
    assert.equal(existsSync(join(project.root, "api.surface.json")), false);
  }
  const excluded = fixture(t, { "src/index.ts": 'export type { Value } from "./hidden.js";', "src/hidden.ts": "export interface Value { size: number; }" });
  excluded.context.files = excluded.context.files.filter((file) => file !== "src/hidden.ts");
  assert.throws(excluded.proposal, /inventory/);
});

test("interpretation options are bound even when the emitted optional property stays the same", (t) => {
  const project = fixture(t, { "src/index.ts": "export interface Value { name?: string; }" });
  project.accept();
  project.write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2022", strict: true, types: [], exactOptionalPropertyTypes: true }, include: ["src/**/*"] }));
  changed(project.context);
  assert.equal(project.value().compiler.options.exactOptionalPropertyTypes, true);
});

test("v1 remains name-only, v2 requires explicit migration, and fix never updates either contract", (t) => {
  const project = fixture(t, { "src/index.ts": "export function value(input: number): number { return input; }" }, { signatures: false });
  const before = project.accept(); assert.equal(JSON.parse(before).schemaVersion, 1);
  project.write("src/index.ts", "export function value(input: string): string { return input; }");
  assert.deepEqual(check(project.context), []);
  project.context.config.projects[0].surface.signatures = true;
  assert.ok(check(project.context).some((item) => item.status === "incomplete" && /schemaVersion 2/.test(item.message)));
  assert.equal(readFileSync(join(project.root, "api.surface.json"), "utf8"), before);
  const approved = project.accept(); assert.equal(JSON.parse(approved).schemaVersion, 2);
  project.write("src/index.ts", "export function value(input: number): number { return input; }");
  changed({ ...project.context, mode: "fix" });
  assert.equal(readFileSync(join(project.root, "api.surface.json"), "utf8"), approved);
});

test("snapshot ownership validation rejects malformed or disconnected signature evidence", (t) => {
  const valid = fixture(t, { "src/index.ts": "export const value: number = 1;" }).value();
  assert.equal(surfaceSnapshotIsValid(valid), true);
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.routing = "invalid JSON"; },
    (value) => { value.targets["."].module = "./missing.ts"; },
    (value) => { value.targets["."].priority = [-1]; },
    (value) => { value.compiler.libraries = "not-a-hash"; },
    (value) => { value.signatures["./src/index.ts"].references.missing = "./missing.ts"; },
    (value) => { value.signatures["./src/index.ts"].declaration = null; },
  ]) {
    const value = structuredClone(valid); mutate(value); assert.equal(surfaceSnapshotIsValid(value), false);
  }
});

test("blocked and non-script condition changes remain observable when script targets are identical", (t) => {
  const project = fixture(t, { "src/index.ts": "export const value: number = 1;" }, { exports: { node: null, default: "./src/index.ts" } });
  project.accept();
  project.write("package.json", JSON.stringify({ name: "signature-fixture", version: "1.0.0", type: "module", exports: { browser: null, default: "./src/index.ts" } }));
  changed(project.context);
  assert.equal(JSON.parse(project.value().routing).browser, null);
});

test("an entry's own ambient globals remain part of the contract even when no exported type names them", (t) => {
  const source = (type) => `export const value: number = 1;
    declare global {
      interface PublicGlobal { field: ${type}; next?: PublicGlobal; }
      namespace PublicNamespace { const version: 1; interface Options { field: ${type}; } }
    }
  `;
  const project = fixture(t, { "src/index.ts": source("string") });
  const value = project.value(), text = declarations(value);
  assert.match(text, /declare global/); assert.match(text, /interface PublicGlobal/);
  assert.match(text, /namespace PublicNamespace/); assert.match(text, /version: 1/);
  assert.match(text, /field: string/);
  project.accept(); assert.deepEqual(check(project.context), []);
  project.write("src/index.ts", source("number"));
  changed(project.context);
});

test("ambient effects in cyclic bare-import modules are retained with finite traversal", (t) => {
  const source = (type) => `import "./index.js"; export {}; declare global { interface CycleAmbient { field: ${type}; } }`;
  const project = fixture(t, { "src/index.ts": 'import "./ambient.js"; export const value: number = 1;', "src/ambient.ts": source("string") });
  const value = project.value();
  assert.match(value.signatures["./src/ambient.ts"].declaration, /CycleAmbient/);
  assert.match(declarations(value), /field: string/);
  project.accept(); project.write("src/ambient.ts", source("number"));
  changed(project.context);
});

test("triple-slash ambient dependencies are explicitly incomplete even if declaration emit removes their directives", (t) => {
  for (const directive of ['/// <reference path="./ambient.d.ts" />', '/// <reference types="ambient-provider" />', '/// <reference lib="es2022" />']) {
    const project = fixture(t, {
      "src/index.ts": `${directive}\nexport const value: number = 1;`,
      "src/ambient.d.ts": "interface AmbientPublic { field: string; }",
      "node_modules/@types/ambient-provider/package.json": JSON.stringify({ name: "@types/ambient-provider", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/@types/ambient-provider/index.d.ts": "interface ProviderAmbient { field: string; }",
    });
    assert.throws(project.proposal, /reference directives/);
    assert.ok(check(project.context).some((item) => item.status === "incomplete" && /reference directives/.test(item.message)));
    assert.equal(existsSync(join(project.root, "api.surface.json")), false);
  }
});
