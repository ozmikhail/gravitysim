import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { Analysis, check, snapshot } from "../src/index.mjs";

const compiler = JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2022", strict: true, allowJs: true, verbatimModuleSyntax: true, paths: { "@app/*": ["./src/*"] } } });
const fixture = (t, source, config = {}) => {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-semantic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = { "tsconfig.json": compiler, ...source };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return { root, files: Object.keys(files), mode: "check", config: { preset: "portable", projects: [], contracts: {}, ...config } };
};
const rules = (diagnostics, rule) => diagnostics.filter((item) => item.rule === rule);
const graph = { entries: ["entry.ts"], within: ".", refuse: { packages: "^forbidden$", extensions: [".tsx"] }, reason: "the loader cannot execute components" };

test("root graph follows .js-to-.ts, JS index and tsconfig aliases through one resolver", (t) => {
  const context = fixture(t, {
    "entry.ts": 'import "./src/runtime.js";',
    "src/runtime.ts": 'import "../lib"; import "@app/component";',
    "lib/index.js": 'import "forbidden";',
    "src/component.tsx": "export const Widget = 1;",
  }, { contracts: { importGraphs: [graph] } });
  const diagnostics = check(context);
  assert.equal(rules(diagnostics, "javascript.analysis").length, 0, JSON.stringify(diagnostics));
  assert.equal(rules(diagnostics, "contracts.import-graphs").length, 2);
  assert.ok(diagnostics.some((item) => item.message.includes("forbidden")));
  assert.ok(diagnostics.some((item) => item.path === "src/component.tsx"));
});

test("single-character nested projects use their own compiler configuration", (t) => {
  const context = fixture(t, {
    "src/local.ts": "export const from = 'root';",
    "a/entry.ts": 'import "@app/local";',
    "a/src/local.ts": "export const from = 'nested';",
    "a/tsconfig.json": compiler,
  }, { projects: [{ root: ".", profile: "typescript" }, { root: "a", profile: "typescript" }] });
  assert.equal(new Analysis(context).target("a/entry.ts", "@app/local"), "a/src/local.ts");
  context.config.projects.reverse();
  assert.equal(new Analysis(context).target("a/entry.ts", "@app/local"), "a/src/local.ts");
});

test("validated project references reach compiler programs and their cache identity", (t) => {
  const context = fixture(t, {
    "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" }, files: ["entry.ts"], references: [{ path: "./lib" }] }),
    "entry.ts": "export const entry = 1;",
    "lib/tsconfig.json": JSON.stringify({ compilerOptions: { composite: true }, files: ["source.ts"] }),
    "lib/source.ts": "export const value = 1;",
  });
  const analysis = new Analysis(context);
  const parsed = analysis.compilerConfig("tsconfig.json");
  assert.ok(analysis.configs.has("lib/tsconfig.json"));
  const program = analysis.program("entry.ts", [], parsed.options, parsed.fileNames, parsed.projectReferences);
  assert.deepEqual(program.getProjectReferences(), parsed.projectReferences);
  assert.equal(program, analysis.program("entry.ts", [], parsed.options, parsed.fileNames, parsed.projectReferences));
  assert.notEqual(program, analysis.program("entry.ts", [], parsed.options, parsed.fileNames));
});

test("missing, cyclic and escaping reference configurations fail closed", (t) => {
  const config = (reference) => JSON.stringify({ files: ["entry.ts"], references: [{ path: reference }] });
  const context = fixture(t, {
    "tsconfig.json": config("./lib"),
    "entry.ts": "export const entry = 1;",
    "lib/entry.ts": "export const value = 1;",
  });
  assert.throws(() => new Analysis(context).compilerConfig("tsconfig.json"), /lib/);
  writeFileSync(join(context.root, "lib/tsconfig.json"), config(".."));
  assert.throws(() => new Analysis(context).compilerConfig("tsconfig.json"), /references contain a cycle/);
  writeFileSync(join(context.root, "lib/tsconfig.json"), config("../../outside"));
  assert.throws(() => new Analysis(context).compilerConfig("tsconfig.json"), /escapes the project root/);
});

test("recursive reference reads use the context path guard and input reader", (t) => {
  const context = fixture(t, {
    "tsconfig.json": JSON.stringify({ files: ["entry.ts"], references: [{ path: "./lib" }] }),
    "entry.ts": "export const entry = 1;",
    "lib/tsconfig.json": JSON.stringify({ files: ["source.ts"] }),
    "lib/source.ts": "export const value = 1;",
  });
  const read = [];
  context.read = (file) => { read.push(file); return readFileSync(join(context.root, file), "utf8"); };
  new Analysis(context).compilerConfig("tsconfig.json");
  assert.deepEqual(read, ["tsconfig.json", "lib/tsconfig.json"]);
  context.safePath = (file) => {
    if (file === "lib/tsconfig.json") throw new Error("blocked reference path");
    return join(context.root, file);
  };
  assert.throws(() => new Analysis(context).compilerConfig("tsconfig.json"), /blocked reference path/);
});

test("unresolved local imports fail incomplete instead of disappearing from a graph", (t) => {
  const context = fixture(t, { "entry.ts": 'import "./missing";' }, { contracts: { importGraphs: [graph] } });
  const [diagnostic] = check(context);
  assert.equal(diagnostic.rule, "javascript.analysis");
  assert.equal(diagnostic.status, "incomplete");
  assert.equal(diagnostic.suppressible, false);
  assert.match(diagnostic.message, /Cannot resolve local dependency/);
});

test("resolved aliases and absolute dependencies cannot escape the checked inventory", (t) => {
  const parent = fixture(t, {
    "outside.ts": 'import "forbidden";',
    "project/entry.ts": "export {};",
    "project/tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "@outside": ["../outside.ts"] } } }),
  }, { contracts: { importGraphs: [graph], boundaries: [{ from: ["entry.ts"], deny: ["private/**"], reason: "entry cannot reach private modules" }] } });
  const context = { ...parent, root: join(parent.root, "project"), files: ["entry.ts", "tsconfig.json"] };
  for (const specifier of ["@outside", join(parent.root, "outside.ts").replaceAll("\\", "/")]) {
    writeFileSync(join(context.root, "entry.ts"), `import ${JSON.stringify(specifier)};`);
    const diagnostics = check(context);
    assert.equal(diagnostics.length, 2, JSON.stringify(diagnostics));
    assert.ok(diagnostics.every((item) => item.rule === "javascript.analysis" && item.status === "incomplete" && item.suppressible === false));
    assert.ok(diagnostics.every((item) => item.message.includes("leaves the checked root")));
  }
});

test("installed external dependencies remain outside local graph traversal", (t) => {
  const context = fixture(t, {
    "entry.ts": 'import "external";',
    "node_modules/external/index.d.ts": "export const value: number;",
  }, { contracts: { importGraphs: [graph] } });
  context.files = context.files.filter((file) => !file.startsWith("node_modules/"));
  assert.deepEqual(check(context), []);
});

test("declaration files cannot hide a local runtime implementation from graph analysis", (t) => {
  const context = fixture(t, {
    "entry.ts": 'import "./src/runtime";',
    "src/runtime.d.ts": "export const value: number;",
    "src/runtime.js": 'import "forbidden"; export const value = 1;',
  }, { contracts: { importGraphs: [graph] } });
  assert.equal(rules(check(context), "contracts.import-graphs").length, 1);
  rmSync(join(context.root, "src/runtime.js"));
  context.files = context.files.filter((file) => file !== "src/runtime.js");
  assert.equal(check(context)[0].status, "incomplete");
});

test("type-only declarations erase edges while inline type reexports keep their runtime edge", (t) => {
  const context = fixture(t, {
    "entry.ts": 'import type { T } from "./types"; export type { T } from "./types";',
    "types.tsx": "export interface T { value: string }",
  }, { contracts: { importGraphs: [graph] } });
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "entry.ts"), 'export { type T } from "./types";');
  assert.equal(rules(check(context), "contracts.import-graphs").length, 1);
});

test("a typo in a contract entry glob or graph scope cannot pass with an empty selection", (t) => {
  const context = fixture(t, { "entry.ts": "export const entry = 1;" }, { contracts: { importGraphs: [{ ...graph, entries: ["gone/**"] }, { ...graph, within: "missing" }] } });
  assert.equal(rules(check(context), "javascript.analysis").length, 2);
});

test("boundary checks resolve aliases and check type imports", (t) => {
  const context = fixture(t, {
    "src/domain.ts": 'import type { Hidden } from "@app/impl/private.js"; export type Value = Hidden;',
    "src/impl/private.ts": "export interface Hidden { value: string }",
  }, { contracts: { boundaries: [{ from: ["./src/domain.ts"], deny: ["src/impl/**"], reason: "domain owns the interface" }] } });
  const diagnostics = check(context);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, "contracts.boundaries");
  assert.match(diagnostics[0].message, /src\/impl\/private.ts/);
});

test("boundaries refuse computed import paths and allow unrelated modules", (t) => {
  const context = fixture(t, { "src/domain.ts": 'export const read = () => import("node:fs");' }, { contracts: { boundaries: [{ from: ["src/**"], deny: ["react", "src/http/**"], reason: "domain stays independent" }] } });
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "src/domain.ts"), "const name = 'node:fs'; export const read = () => import(name);");
  assert.equal(rules(check(context), "contracts.boundaries").length, 1);
});

const catalogue = { file: "src/catalogue.ts", variable: "sources", entry: "./entry.ts" };
test("manifest coverage accepts literal templates, TSX and explicit type-only imports", (t) => {
  const context = fixture(t, {
    "src/catalogue.ts": "export const sources = [`./entry.ts`, './view.tsx'] as const;",
    "src/entry.ts": 'import { view } from "./view"; import type { T } from "./unbuilt"; export {view};',
    "src/view.tsx": "export const view = 1;",
  }, { contracts: { manifests: [catalogue] } });
  assert.deepEqual(check(context), []);
});

test("manifest coverage refuses omitted inline type reexports, duplicates and stale exemptions", (t) => {
  const context = fixture(t, {
    "src/catalogue.ts": 'export const sources = ["./entry.ts", "./entry.ts", "./missing.ts"];',
    "src/entry.ts": 'export { type View } from "./view";',
    "src/view.tsx": "export interface View { value: string }",
  }, { contracts: { manifests: [{ ...catalogue, exempt: [{ path: "src/unused.ts", reason: "old exemption" }] }] } });
  const diagnostics = check(context);
  assert.equal(rules(diagnostics, "javascript.analysis").length, 0);
  assert.equal(rules(diagnostics, "contracts.manifests").length, 4);
});

test("nonliteral manifests and dynamic dependencies are refused", (t) => {
  const context = fixture(t, {
    "src/catalogue.ts": "export const sources = discover();",
    "src/entry.ts": "export const value = 1;",
  }, { contracts: { manifests: [catalogue] } });
  assert.equal(rules(check(context), "contracts.manifests").length, 1);
  writeFileSync(join(context.root, "src/catalogue.ts"), 'export const sources = ["./entry.ts"];');
  writeFileSync(join(context.root, "src/entry.ts"), "export const load = (name: string) => import(name);");
  assert.equal(rules(check(context), "contracts.manifests").length, 1);
});

const lazy = { loader: "src/router.ts", listing: { file: "scripts/pages.ts", pattern: "^src/.+\\.tsx$", root: "." }, names: { files: "src/**", pattern: "-page\\.tsx$" } };
test("lazy imports, template-literal catalogue and names agree", (t) => {
  const context = fixture(t, {
    "src/router.ts": "export const pages = [() => import(`./home-page`)];",
    "src/home-page.tsx": "export const Home = 1;",
    "scripts/pages.ts": "export const pages = [`src/home-page.tsx`];",
  }, { contracts: { lazyModules: [lazy] } });
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "scripts/pages.ts"), 'export const pages = ["src/gone-page.tsx"];');
  assert.equal(rules(check(context), "contracts.lazy-modules").length, 2);
});

test("unresolved and computed lazy imports cannot silently produce empty coverage", (t) => {
  const context = fixture(t, {
    "src/router.ts": 'export const pages = [() => import("./missing")];',
    "scripts/pages.ts": "export const pages = [];",
  }, { contracts: { lazyModules: [lazy] } });
  assert.equal(check(context)[0].status, "incomplete");
  writeFileSync(join(context.root, "src/router.ts"), 'const path = "./missing"; export const pages = [() => import(path)];');
  assert.equal(rules(check(context), "contracts.lazy-modules").length, 1);
});

test("written-once tables include template literals and ignore type positions", (t) => {
  const context = fixture(t, {
    "src/paths.ts": "export const paths = { pricing: `/pricing` };",
    "src/menu.ts": 'type Path = "/pricing"; export const link = "/pricing";',
    "src/menu.test.ts": 'export const expected = "/pricing";',
  }, { contracts: { writtenOnce: [{ table: "src/paths.ts", values: "^/.", files: ["src/**"], ignore: ["**/*.test.ts"] }] } });
  const diagnostics = check(context);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, "contracts.written-once");
  assert.equal(diagnostics[0].path, "src/menu.ts");
});

test("a written-once pattern that finds no values is incomplete", (t) => {
  const context = fixture(t, { "src/paths.ts": "export const paths = {};" }, { contracts: { writtenOnce: [{ table: "src/paths.ts", values: "^/.", files: ["src/**"] }] } });
  assert.equal(check(context)[0].status, "incomplete");
});

test("root-project unique exports cover destructuring and renamed reexports", (t) => {
  const context = fixture(t, {
    "src/a.ts": "export const { shared } = { shared: 1 }; export const original = 2;",
    "src/b.ts": 'export { original as shared } from "./a";',
    "src/c.ts": 'export { original } from "./a";',
  }, { projects: [{ root: ".", profile: "typescript", uniqueExports: ["src"] }] });
  const diagnostics = check(context);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, "exports.unique");
  assert.equal(diagnostics[0].path, "src/b.ts");
});

test("overloads and same-file type/value merges have one unique-export owner", (t) => {
  const context = fixture(t, { "src/a.ts": "export function read(a: string): string; export function read(a: unknown): unknown { return a; } export interface Value { a: 1 } export const Value = 1;" }, { projects: [{ root: ".", profile: "typescript", uniqueExports: ["src"] }] });
  assert.deepEqual(check(context), []);
});

const registration = { sources: "src", call: { name: "register", from: "src/registry.ts" }, registrar: { files: "src/jobs.ts", suffix: "RegisterJobs" }, composition: { file: "src/composition.ts", function: "compose" } };
const registrationSources = {
  "src/registry.ts": "export const register = (name: string): void => undefined;",
  "src/jobs.ts": 'import { register as add } from "./registry"; export const billingRegisterJobs = (): void => { add("sweep"); };',
  "src/composition.ts": 'import { billingRegisterJobs as jobs } from "./jobs"; export const compose = (): void => { jobs(); };',
};
test("registration contracts resolve aliases and count one direct lexical composition call", (t) => {
  const context = fixture(t, registrationSources, { contracts: { registrations: [registration] } });
  assert.deepEqual(check(context), []);
});

test("generator and accessor registration bodies are refused", (t) => {
  const context = fixture(t, {
    ...registrationSources,
    "src/jobs.ts": 'import { register } from "./registry"; export function* billingRegisterJobs() { register("sweep"); } export const otherRegisterJobs = () => { class Box { get value() { register("late"); return 1; } } return Box; };',
  }, { contracts: { registrations: [registration] } });
  assert.ok(rules(check(context), "contracts.registrations").length >= 2);
});

test("conditional, duplicate and outside registrar calls are refused", (t) => {
  const context = fixture(t, {
    ...registrationSources,
    "src/composition.ts": 'import { billingRegisterJobs as jobs } from "./jobs"; export const compose = (): void => { if (true) jobs(); jobs(); jobs(); }; jobs();',
  }, { contracts: { registrations: [registration] } });
  assert.equal(rules(check(context), "contracts.registrations").length, 3);
});

const packageProject = { root: ".", profile: "typescript", surface: { snapshot: "api.surface.json" } };
test("surface proposals support shorthand exports and do not write their own baseline", (t) => {
  const context = fixture(t, {
    "package.json": JSON.stringify({ exports: "./src/index.ts" }),
    "src/index.ts": "export const Widget = 1; export interface WidgetProps { size: number }",
  }, { projects: [packageProject] });
  const [proposal] = snapshot(context);
  assert.equal(proposal.path, "api.surface.json");
  assert.deepEqual(JSON.parse(proposal.content), { schemaVersion: 1, exports: { ".": ["Widget", "WidgetProps (type)"] } });
  assert.equal(existsSync(join(context.root, "api.surface.json")), false);
  assert.equal(rules(check(context), "exports.surface").length, 1);
  writeFileSync(join(context.root, "api.surface.json"), proposal.content);
  context.files.push("api.surface.json");
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "src/index.ts"), "export const Widget = 1;");
  assert.equal(rules(check({ ...context, mode: "fix" }), "exports.surface").length, 1);
  assert.equal(readFileSync(join(context.root, "api.surface.json"), "utf8"), proposal.content);
});

test("surfaces pin nested conditions separately and include JavaScript exports", (t) => {
  const context = fixture(t, {
    "package.json": JSON.stringify({ exports: { ".": { import: { types: "./src/types.ts", default: "./src/index.js" }, require: "./src/index.cjs" } } }),
    "src/types.ts": "export interface Widget { size: number }",
    "src/index.js": "export const Widget = 1;",
    "src/index.cjs": "exports.Widget = 1;",
  }, { projects: [packageProject] });
  const exported = JSON.parse(snapshot(context)[0].content).exports;
  assert.deepEqual(exported[". [import/types]"], ["Widget (type)"]);
  assert.deepEqual(exported[". [import/default]"], ["Widget"]);
  assert.ok(exported[". [require]"].includes("Widget"));
});

test("surface wildcard expansion uses the supplied inventory", (t) => {
  const context = fixture(t, {
    "package.json": JSON.stringify({ exports: { "./*": "./src/*.ts" } }),
    "src/one.ts": "export const one = 1;",
    "src/two.ts": "export const two = 2;",
  }, { projects: [packageProject] });
  assert.deepEqual(JSON.parse(snapshot(context)[0].content).exports, { "./one": ["one"], "./two": ["two"] });
});

test("type-only named and star reexports retain their type-only surface category", (t) => {
  const context = fixture(t, {
    "package.json": JSON.stringify({ exports: "./src/index.ts" }),
    "src/index.ts": 'export type { Widget } from "./widget"; export type * from "./other";',
    "src/widget.ts": "export class Widget {}",
    "src/other.ts": "export class Other {}",
  }, { projects: [packageProject] });
  assert.deepEqual(JSON.parse(snapshot(context)[0].content).exports["."], ["Other (type)", "Widget (type)"]);
});

test("type-only export categories survive transitive star barrels", (t) => {
  const context = fixture(t, {
    "package.json": JSON.stringify({ exports: "./src/index.ts" }),
    "src/index.ts": 'export * from "./types"; export * from "./values";',
    "src/types.ts": 'export type * from "./widget";',
    "src/widget.ts": "export class Widget {}",
    "src/values.ts": 'export * from "./index"; export const value = 1;',
  }, { projects: [packageProject] });
  assert.deepEqual(JSON.parse(snapshot(context)[0].content).exports["."], ["Widget (type)", "value"]);
});

test("missing surface config, export target or local reexport is incomplete", (t) => {
  const context = fixture(t, {
    "package.json": JSON.stringify({ exports: "./src/index.ts" }),
    "src/index.ts": 'export * from "./missing";',
  }, { projects: [packageProject] });
  assert.equal(check(context)[0].status, "incomplete");
  rmSync(join(context.root, "tsconfig.json"));
  assert.equal(check(context)[0].status, "incomplete");
  assert.throws(() => snapshot(context));
});

test("an unresolved external reexport cannot become an empty successful API snapshot", (t) => {
  const context = fixture(t, {
    "package.json": JSON.stringify({ exports: "./src/index.ts" }),
    "src/index.ts": 'export * from "missing-package";',
  }, { projects: [packageProject] });
  assert.equal(check(context)[0].status, "incomplete");
  assert.throws(() => snapshot(context), /could not be resolved/);
});

test("the snapshot API cannot propose overwriting source or another project's files", (t) => {
  const context = fixture(t, {
    "package.json": JSON.stringify({ exports: "./src/index.ts" }),
    "src/index.ts": "export const value = 1;",
  }, { projects: [{ ...packageProject, surface: { snapshot: "src/index.ts" } }] });
  assert.throws(() => snapshot(context), /surface\.json/);
  context.config.projects[0].surface.snapshot = "../other.surface.json";
  assert.throws(() => snapshot(context));
  assert.equal(readFileSync(join(context.root, "src/index.ts"), "utf8"), "export const value = 1;");
});

test("focused and skipped test markers include import aliases, options and chained each calls", (t) => {
  const context = fixture(t, {
    "src/example.test.ts": 'import { test as check } from "node:test"; check("one", { only: true }, () => {}); describe.only.each([1])("set", () => {}); test.skip("pending", () => {}); test("normal", { skip: false }, () => {});',
  }, { preset: "ozlabs" });
  const diagnostics = check(context);
  assert.equal(rules(diagnostics, "tests.focused").length, 2);
  assert.equal(rules(diagnostics, "tests.skipped").length, 1);
});

test("normal tests pass and malformed source fails incomplete", (t) => {
  const context = fixture(t, { "src/example.test.ts": 'import { test } from "node:test"; test("all", () => {});' }, { preset: "ozlabs" });
  assert.deepEqual(check(context), []);
  writeFileSync(join(context.root, "src/example.test.ts"), "export const broken = ;");
  assert.equal(check(context)[0].status, "incomplete");
});

test("Node test contexts are checked and data in test folders is not parsed as source", (t) => {
  const context = fixture(t, {
    "tests/sample.mjs": 'import test from "node:test"; test("outer", (context) => context.test("inner", { skip: true }, () => {}));',
    "tests/data.json": '{"word":"test.only"}',
  }, { preset: "ozlabs" });
  const diagnostics = check(context);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, "tests.skipped");
});

test("one Analysis reuses source and compiler programs without changing check behavior", (t) => {
  const context = fixture(t, registrationSources, { contracts: { registrations: [registration] } });
  const analysis = new Analysis(context);
  assert.equal(analysis.source("src/jobs.ts"), analysis.source("./src/jobs.ts"));
  assert.equal(analysis.program("src/composition.ts"), analysis.program("src/composition.ts"));
  assert.deepEqual(check(context, analysis), []);
});

test("semantic runtime imports from node_modules without TypeScript source stripping", (t) => {
  const context = fixture(t, {});
  const installed = join(context.root, "node_modules", "@ozlabs", "plumb-javascript");
  mkdirSync(join(installed, "shared"), { recursive: true });
  cpSync(new URL("../src/", import.meta.url), join(installed, "src"), { recursive: true });
  cpSync(new URL("../shared/module-resolver.mjs", import.meta.url), join(installed, "shared", "module-resolver.mjs"));
  const require = createRequire(import.meta.url);
  const typescript = dirname(require.resolve("typescript/package.json"));
  symlinkSync(typescript, join(context.root, "node_modules", "typescript"), process.platform === "win32" ? "junction" : "dir");
  const entry = pathToFileURL(join(installed, "src", "index.mjs")).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `const { check } = await import(${JSON.stringify(entry)}); process.stdout.write(typeof check);`], { encoding: "utf8" });
  assert.equal(output, "function");
});
