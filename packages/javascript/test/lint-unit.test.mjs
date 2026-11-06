import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { test } from "node:test";

// resolve the real core peer in a source checkout without installing optional language engines
const peer = registerHooks({ resolve(specifier, context, next) {
  if (["@ozlabs/plumb/files", "@ozlabs/plumb/comments"].includes(specifier)) {
    return { url: new URL(`../../../src/${specifier.split("/").at(-1)}.mjs`, import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { eslintGlobs, scopeProblems, validateOptions } = await import("../eslint/options.mjs");
const { plumbComponentRules } = await import("../eslint/react/components.mjs");
const { plumbCallRules } = await import("../eslint/rules/calls.mjs");
const { plumbLayoutRules } = await import("../eslint/rules/layout.mjs");
const { plumbCommentRules } = await import("../eslint/rules/comments.mjs");
const { plumbBoundaryRules } = await import("../eslint/rules/boundaries.mjs");
const { plumbValueRules } = await import("../eslint/rules/values.mjs");
const { scopedRule } = await import("../eslint/scoped.mjs");
const { syntaxSelectors } = await import("../eslint/syntax.mjs");
const { typeCheckedRules, typeInformationRule } = await import("../eslint/typed-policy.mjs");
const { errorHandlingRule } = await import("../eslint/errors.mjs");
const { createCompilerIO } = await import("../shared/compiler-host.mjs");
const { globMatches } = await import("../shared/glob.mjs");
peer.deregister();

test("compiler I/O records source, dependencies and missing probes without crossing its root", async () => {
  const { context } = await import("../../../src/engine.mjs");
  const parent = await mkdtemp(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-compiler-inputs-"));
  try {
    const root = join(parent, "candidate"), library = join(parent, "typescript");
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true }); mkdirSync(library);
    writeFileSync(join(root, "plumb.json"), '{"schemaVersion":1,"preset":"portable"}\n');
    writeFileSync(join(root, "main.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "node_modules/pkg/package.json"), '{"types":"index.d.ts"}\n');
    writeFileSync(join(library, "lib.d.ts"), "declare const standard: number;\n");
    writeFileSync(join(parent, "outside.ts"), "export const outside = 1;\n");
    const compiler = { getDefaultLibFilePath: () => join(library, "lib.d.ts"), sys: { readFile: (file) => readFileSync(file, "utf8"), useCaseSensitiveFileNames: true } };
    const ctx = context({ root }), io = createCompilerIO(root, ctx, compiler);
    assert.equal(io.fileExists(join(root, "main.ts")), true);
    assert.equal(io.fileExists(join(root, "missing.ts")), false);
    assert.match(io.readFile(join(root, "node_modules/pkg/package.json")), /index\.d\.ts/);
    assert.equal(ctx.compilerInputs.get("missing.ts"), null);
    assert.ok(ctx.compilerInputs.has("node_modules/pkg/package.json"));
    assert.equal(io.directoryExists(join(root, "missing-directory")), false);
    assert.ok(ctx.compilerDirectories.has("."));
    assert.equal(io.fileExists(join(parent, "outside.ts")), false);
    assert.throws(() => io.readFile(join(parent, "outside.ts")), /escapes/);
    assert.match(io.readFile(join(library, "lib.d.ts")), /standard/);
    assert.throws(() => io.readFile(join(root, ".git/config")), /reserved|unsafe/i);
    if (process.platform !== "win32") {
      symlinkSync(join(parent, "outside.ts"), join(root, "linked.ts"));
      const unsafe = createCompilerIO(root, context({ root }), compiler);
      assert.throws(() => unsafe.fileExists(join(root, "linked.ts")), /unsupported|symbolic/i);
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("typed lint requires a trusted Program containing the current source", () => {
  const node = { type: "Program" }, reports = [], program = { getSourceFile: () => ({ text: "export const value = 1;" }) };
  const context = { filename: "/repo/a.ts", report: (item) => reports.push(item), settings: { plumbTrustedPrograms: [program] }, sourceCode: { text: "export const value = 1;", parserServices: { program, esTreeNodeToTSNodeMap: new Map() } } };
  typeInformationRule.create(context).Program(node);
  assert.deepEqual(reports, []);
  for (const changed of [{ ...context, settings: {} }, { ...context, sourceCode: { ...context.sourceCode, text: "export const value = 2;" } }, { ...context, sourceCode: { ...context.sourceCode, parserServices: {} } }]) typeInformationRule.create(changed).Program(node);
  assert.equal(reports.length, 3);
  assert.ok(reports.every((item) => item.messageId === "unresolved"));
  assert.equal(typeCheckedRules["@typescript-eslint/no-floating-promises"][1].ignoreVoid, false);
  assert.equal(typeCheckedRules["@typescript-eslint/no-floating-promises"][1].checkThenables, true);
});

const identifier = (name) => ({ type: "Identifier", name });
const member = (object, key, computed = false) => ({ type: "MemberExpression", object, property: computed && typeof key === "string" ? { type: "Literal", value: key } : typeof key === "string" ? identifier(key) : key, computed });
function ownership(rows, bindings = new Map()) {
  const reports = [], context = { cwd: "/repo", filename: "/repo/src/main.ts", options: [{ rows }], sourceCode: { getScope: () => ({ set: bindings }) }, report: (item) => reports.push(item) };
  const bind = (name, init, pattern = identifier(name)) => {
    const node = { type: "VariableDeclarator", id: pattern, init }, value = { defs: [{ type: "Variable", node }], references: [] };
    bindings.set(name, value); return { node, value };
  };
  return { reports, visitors: plumbBoundaryRules.owners.create(context), bindings, bind };
}

test("ownership follows immutable aliases, destructuring and literal computed properties", () => {
  const row = { member: "process.env", owner: ["src/config.ts"], message: "use config" };
  const env = ownership([row]); env.bind("host", identifier("process")); env.bind("key", { type: "Literal", value: "env" });
  env.visitors.MemberExpression(member(identifier("host"), identifier("key"), true));
  assert.equal(env.reports[0].messageId, "owner");
  const clock = ownership([{ now: true, owner: ["src/clock.ts"], message: "use clock" }]);
  clock.bind("Clock", identifier("Date")); clock.visitors.MemberExpression(member(identifier("Clock"), "now", true));
  assert.equal(clock.reports[0].messageId, "owner");
  const pattern = { type: "ObjectPattern", properties: [{ type: "Property", key: identifier("env"), value: identifier("configuration"), computed: false }] };
  const destructured = ownership([row]); const { node } = destructured.bind("configuration", identifier("process"), pattern);
  destructured.visitors.VariableDeclarator(node);
  assert.equal(destructured.reports[0].messageId, "owner");
  const boxed = ownership([row]); boxed.bind("box", { type: "ObjectExpression", properties: [{ type: "Property", key: identifier("host"), value: identifier("process"), computed: false }] });
  boxed.visitors.MemberExpression(member(member(identifier("box"), "host"), "env"));
  assert.equal(boxed.reports[0].messageId, "owner");
});

test("governed computed and reassigned references are incomplete; local shadows are not effects", () => {
  const row = { member: "process.env", owner: [], message: "use config" };
  const computed = ownership([row]); computed.visitors.MemberExpression(member(identifier("process"), identifier("unknownKey"), true));
  assert.equal(computed.reports[0].messageId, "unresolved");
  const reassigned = ownership([row]), { value } = reassigned.bind("host", identifier("process"));
  value.references.push({ isWrite: () => true, init: false, identifier: { parent: { type: "AssignmentExpression", right: identifier("other") } } });
  reassigned.visitors.MemberExpression(member(identifier("host"), "env"));
  assert.equal(reassigned.reports[0].messageId, "unresolved");
  const shadow = ownership([row, { now: true, construct: ["Date"], owner: [], message: "use clock" }]);
  shadow.bindings.set("process", { defs: [{ type: "Parameter" }] }); shadow.bindings.set("Date", { defs: [{ type: "ClassName" }] });
  shadow.visitors.MemberExpression(member(identifier("process"), "env"));
  shadow.visitors.NewExpression({ callee: identifier("Date"), arguments: [] });
  shadow.visitors.MemberExpression(member({ type: "MetaProperty", meta: identifier("import"), property: identifier("meta") }, "env"));
  assert.deepEqual(shadow.reports, []);
});

test("error conventions reject invalid descriptors and missing typed evidence", () => {
  for (const errorHandling of [{ factories: [] }, { result: { name: "Result" } }, { result: { from: "model", name: "*" } }, { background: [{ from: "async", name: "run", safe: true }] }, { files: ["../outside"], factories: [{ from: "errors", name: "fail" }] }]) assert.throws(() => validateOptions({ errorHandling }));
  assert.doesNotThrow(() => validateOptions({ errorHandling: { files: ["src/**"], factories: [{ from: "@app/errors", name: "fail" }], result: { from: "@app/result", name: "Result" }, background: [{ from: "@app/async", name: "background" }] } }));
  const reports = [], context = { cwd: "/repo", filename: "/repo/src/a.ts", options: [{ result: { from: "model", name: "Result" } }], sourceCode: {}, report: (item) => reports.push(item) };
  const visitors = errorHandlingRule.create(context);
  visitors.Program({ type: "Program" });
  visitors.CatchClause({ body: { type: "BlockStatement", body: [] } });
  visitors.ThrowStatement({ argument: { type: "Literal", value: "bare failure" } });
  assert.ok(reports.some((item) => item.messageId === "unresolved"));
  assert.ok(reports.some((item) => item.messageId === "empty"));
  assert.ok(reports.some((item) => item.messageId === "thrown"));
  assert.equal(scopeProblems({ errorHandling: { files: ["missing/**"] } }, ["src/a.ts"]).length, 1);
});

test("resolved semantic edges cannot leave the root, independent of compiler resolution", async () => {
  // this unit isolates the resolved-path guard; the semantic suite exercises the actual compiler
  const compiler = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "typescript") return { url: "data:text/javascript,export default Object.freeze({});", shortCircuit: true };
    return next(specifier, context);
  } });
  let Analysis;
  try { ({ Analysis } = await import("../src/analysis.mjs")); }
  finally { compiler.deregister(); }
  const root = resolve("resolved-edge-unit");
  const analysis = new Analysis({ root, files: ["entry.ts", "inside.ts"], config: {}, safePath: (file) => resolve(root, file) });
  const outside = resolve(root, "../outside.ts");
  analysis.resolver = { resolve: () => outside };
  for (const specifier of ["@outside", outside, "../outside.ts"]) {
    assert.throws(() => analysis.target("entry.ts", specifier, {}), /leaves the checked root/);
  }
  analysis.resolver = { resolve: () => join(root, "inside.ts") };
  assert.equal(analysis.target("entry.ts", "@inside", {}), "inside.ts");
  analysis.resolver = { resolve: () => join(root, "node_modules", "external", "index.d.ts") };
  assert.equal(analysis.target("entry.ts", "external", {}), undefined);
  analysis.context.config.projects = [{ root: ".", profile: "typescript" }, { root: "a", profile: "typescript" }];
  analysis.compilerConfig = (file) => ({ fileNames: [join(root, "a", "entry.ts")], options: { configFilePath: file } });
  assert.equal(analysis.options("a/entry.ts").configFilePath, join(root, "a", "tsconfig.json"));
  analysis.context.config.projects.reverse();
  assert.equal(analysis.options("a/entry.ts").configFilePath, join(root, "a", "tsconfig.json"));
});

test("inline type imports retain runtime layer and loader restrictions", () => {
  const reports = [];
  const runtime = () => "/repo/src/state/card.tsx";
  const base = { cwd: "/repo", filename: "/repo/src/lib/helper.ts", settings: { plumbResolver: { runtime, isLocal: () => true } }, report: (entry) => reports.push(entry) };
  const layers = plumbBoundaryRules.layers.create({ ...base, options: [{ root: "/repo", layers: [["^src/lib/", 1, "lib"], ["^src/state/", 2, "state"]] }] });
  const loader = plumbValueRules["plain-module"].create({ ...base, options: [{ extensions: [".tsx"], reason: "the loader cannot execute components" }] });
  const inline = { type: "ImportDeclaration", importKind: "value", source: { value: "../state/card" }, specifiers: [{ type: "ImportSpecifier", importKind: "type" }] };
  layers.ImportDeclaration(inline);
  loader.ImportDeclaration(inline);
  assert.deepEqual(reports.map((entry) => entry.messageId), ["up", "refused"]);
  reports.length = 0;
  const erased = { ...inline, importKind: "type" };
  layers.ImportDeclaration(erased);
  loader.ImportDeclaration(erased);
  assert.deepEqual(reports, []);
});

test("options reject unknown nested keys and every preset reconfiguration route", () => {
  const rejected = [
    { plugins: {} },
    { exceptions: [] },
    { ignores: ["**"] },
    { source: ["../elsewhere/**"] },
    { source: ["!src/**"] },
    { errorFactory: { message: "use the factory", allowln: ["src/error.ts"] } },
    { rules: [{ extends: [{ rules: { "no-console": "off" } }] }] },
    { rules: [{ languageOptions: {}, rules: { "plumb/class-style": "error" } }] },
    { rules: [{ rules: { "no-debugger": "off" } }] },
    { rules: [{ rules: { "@typescript-eslint/no-unused-vars": "warn" } }] },
    { rules: [{ rules: { "plumb/class-style": "off" } }] },
    { rules: [{ rules: { "plumb/keyed-numbers": ["error", { keys: ["delay"], typo: true }] } }] },
    { rules: [{ rules: { "plumb/owners": ["error", { root: "/elsewhere", rows: [{ global: "fetch", owner: [], message: "use http" }] }] } }] },
    { rules: [{ rules: { "plumb/literal-calls": ["error", { calls: [{ callee: "[", args: [] }] }] } }] },
    JSON.parse('{"constructor":{}}'),
    JSON.parse('{"__proto__":{}}'),
  ];
  for (const options of rejected) assert.throws(() => validateOptions(options), TypeError, JSON.stringify(options));
  assert.doesNotThrow(() => validateOptions({ source: ["./src/**"], rules: [{ files: ["src/**"], rules: { "plumb/keyed-numbers": ["error", { keys: ["delay"] }] } }] }));
});

test("an opt-in cannot reconfigure another enabled preset contract", () => {
  assert.throws(() => validateOptions({ tailwind: {}, rules: [{ rules: { "plumb-react/class-set": ["error", { inline: false }] } }] }), /cannot reconfigure/);
  assert.doesNotThrow(() => validateOptions({ rules: [{ rules: { "plumb-react/class-set": ["error", { inline: true }] } }] }));
});

test("syntax scopes union and factory allowances never erase other restrictions", () => {
  const options = {
    root: "/repo", profile: "react", source: ["src/**"],
    errorFactory: { message: "use factory", allowIn: ["src/error.ts"] },
    syntax: [
      { selectors: [{ selector: "DebuggerStatement", message: "no debugger" }] },
      { files: ["src/**"], selectors: [{ selector: "WithStatement", message: "no with" }] },
      { files: ["src/error.ts"], selectors: [{ selector: "EmptyStatement", message: "no empty" }] },
    ],
  };
  const selected = syntaxSelectors(options, "/repo/src/error.ts");
  for (const message of ["no debugger", "no with", "no empty", "Await inside a function: a top-level await holds the entry chunk."]) assert.ok(selected.some((entry) => entry.message === message));
  assert.ok(!selected.some((entry) => entry.message === "use factory"));
  const other = syntaxSelectors(options, "/repo/tools/error.ts");
  assert.ok(other.some((entry) => entry.message === "use factory"));
  assert.ok(!other.some((entry) => ["no with", "no empty"].includes(entry.message)));
});

test("overlapping contract rows each preserve their own state", () => {
  const received = [];
  const base = { meta: { schema: [] }, create: (context) => {
    let seen = 0;
    return { Identifier: () => seen++, "Program:exit": () => received.push([context.options[0], seen]) };
  } };
  const context = Object.freeze({ filename: "/repo/src/a.ts", options: [[
    { files: ["src/**"], options: ["outer"] },
    { files: ["src/a.ts"], options: ["inner"] },
    { files: ["tools/**"], options: ["outside"] },
  ]] });
  const visitors = scopedRule(base, "/repo").create(context);
  visitors.Identifier({});
  visitors["Program:exit"]({});
  assert.deepEqual(received, [["outer", 1], ["inner", 1]]);
});

test("imports-first diagnoses order without changing real ESM dependency evaluation", async () => {
  const root = await mkdtemp(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-lint-order-"));
  try {
    const source = 'export { ready } from "./initialize.mjs";\nimport "./consume.mjs";\n';
    await writeFile(join(root, "initialize.mjs"), "globalThis.ready = true; export const ready = true;\n");
    await writeFile(join(root, "consume.mjs"), 'if (!globalThis.ready) throw new Error("initializer has not run");\n');
    await writeFile(join(root, "entry.mjs"), source);
    const reports = [];
    const rule = plumbLayoutRules["imports-first"];
    const visitor = rule.create({ report: (value) => reports.push(value) });
    visitor.Program({ body: [{ type: "ExportNamedDeclaration" }, { type: "ImportDeclaration" }] });
    assert.equal(reports.length, 1);
    assert.equal(rule.meta.fixable, undefined);
    assert.equal(reports[0].fix, undefined);
    assert.equal(spawnSync(process.execPath, [join(root, "entry.mjs")], { encoding: "utf8" }).status, 0);
    const pass = [];
    rule.create({ report: (value) => pass.push(value) }).Program({ body: [{ type: "ImportDeclaration" }, { type: "ExportNamedDeclaration" }] });
    assert.deepEqual(pass, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("client boundaries are retained for wrapper modules and missing directives require review", () => {
  const rule = plumbComponentRules["client-directive"];
  const reports = [];
  const visitors = rule.create({ report: (entry) => reports.push(entry) });
  visitors["Program:exit"]({ body: [{ type: "ExpressionStatement", directive: "use client" }, { type: "ExportNamedDeclaration", source: { value: "third-party-carousel" } }] });
  assert.deepEqual(reports, []);
  visitors.JSXElement({});
  visitors["Program:exit"]({ body: [{ type: "ExportNamedDeclaration" }] });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].fix, undefined);
  assert.equal(rule.meta.fixable, undefined);
});

test("a client marker can share a directive prologue and a later string is not a directive", () => {
  const reports = [];
  const visitors = plumbComponentRules["client-directive"].create({ report: (entry) => reports.push(entry) });
  visitors.JSXElement({});
  visitors["Program:exit"]({ body: [{ type: "ExpressionStatement", directive: "use strict" }, { type: "ExpressionStatement", directive: "use client" }, { type: "ExportNamedDeclaration" }] });
  assert.deepEqual(reports, []);
  visitors["Program:exit"]({ body: [{ type: "ImportDeclaration" }, { type: "ExpressionStatement", directive: "use client" }] });
  assert.equal(reports.length, 1);
});

test("module-scope registrations refuse instance field initializers", () => {
  const reports = [];
  const options = [{ calls: [{ callee: "^register$", args: ["literal"], moduleScope: true }] }];
  const call = { type: "CallExpression", callee: { type: "Identifier", name: "register" }, arguments: [{ type: "Literal", value: "known" }] };
  const field = plumbCallRules["literal-calls"].create({ options, report: (entry) => reports.push(entry), sourceCode: { getAncestors: () => [{ type: "PropertyDefinition", static: false }] } });
  field.CallExpression(call);
  assert.deepEqual(reports.map((entry) => entry.messageId), ["scope"]);
  reports.length = 0;
  plumbCallRules["literal-calls"].create({ options, report: (entry) => reports.push(entry), sourceCode: { getAncestors: () => [{ type: "Program" }] } }).CallExpression(call);
  assert.deepEqual(reports, []);
});

test("visible literal expressions and non-component re-exports cannot bypass React contracts", () => {
  const reports = [];
  const words = plumbComponentRules.words.create({ report: (entry) => reports.push(entry) });
  words.JSXExpressionContainer({ parent: { type: "JSXElement" }, expression: { type: "Literal", value: "Hello world" } });
  assert.equal(reports.length, 1);
  reports.length = 0;
  const refresh = plumbComponentRules["refresh-boundary"].create({ filename: "/repo/card.tsx", report: (entry) => reports.push(entry) });
  refresh.ExportNamedDeclaration({ exportKind: "value", declaration: { type: "FunctionDeclaration", id: { name: "Card" } }, specifiers: [] });
  refresh.ExportNamedDeclaration({ exportKind: "value", source: { value: "./data" }, specifiers: [{ type: "ExportSpecifier", exported: { name: "cardSize" } }] });
  refresh["Program:exit"]();
  assert.equal(reports.length, 1);
});

test("glob matching normalizes root prefixes and platform path separators", () => {
  assert.equal(globMatches(["./src/**/*.{ts,tsx}"], "src/a.tsx"), true);
  assert.equal(globMatches(["src/**"], "src\\deep\\a.ts"), true);
  assert.equal(globMatches(["src/**"], "other/a.ts"), false);
  assert.equal(globMatches(["."], "src/a.ts"), true);
});

test("inline type, formatter and coverage suppressions cannot bypass policy", () => {
  const reports = [];
  const comments = [" @ts-nocheck", " @ts-ignore", " / @ts-ignore", "** @ts-nocheck", " @ts-expect-error because legacy", " prettier-ignore", " c8 ignore next", " eslint-disable-line plumb/directive -- self suppression", " a normal explanation"].map((value) => ({ type: "Line", value, loc: { start: { line: 1 }, end: { line: 1 } } }));
  plumbCommentRules.directive.create({ sourceCode: { getAllComments: () => comments }, report: (entry) => reports.push(entry) }).Program();
  assert.equal(reports.length, comments.length - 1);
});

test("explicit language scopes cannot silently select nothing", () => {
  const options = {
    source: ["source/**"],
    tailwind: { files: ["missing/**"] },
    clientDirective: ["missing/**"],
    words: ["missing/**"],
    lines: ["missing/**"],
    rules: [{ files: ["missing/**"], rules: { "plumb/class-style": "error" } }],
    syntax: [{ files: ["missing/**"], selectors: [{ selector: "DebuggerStatement", message: "no debugger" }] }],
  };
  assert.equal(scopeProblems(options, ["src/card.tsx"]).length, 7);
  assert.deepEqual(scopeProblems({}, ["tools/build.mjs"]), []);
  assert.deepEqual(scopeProblems({ source: ["."], rules: [{ rules: { "plumb/class-style": "error" } }] }, ["tools/build.mjs"]), []);
  assert.equal(scopeProblems({ words: ["src/**"] }, []).length, 1);
});

test("scopes are checked across the combined project-relative inventory", () => {
  const options = { words: ["ui/**"], lines: ["catalogue/**"], rules: [{ files: ["services/**"], rules: { "plumb/class-style": "error" } }] };
  assert.deepEqual(scopeProblems(options, ["ui/card.tsx", "catalogue/en.ts", "services/user.ts"]), []);
  assert.equal(scopeProblems(options, ["ui/card.tsx", "services/user.ts"]).length, 1);
});

test("flat-config scopes retain dot roots, trailing folders, and literal route brackets", () => {
  for (const [pattern, file] of [[".", "tools/build.ts"], ["./src/**", "src/card.tsx"], ["src/", "src/card.tsx"], ["app/[slug]/*.tsx", "app/[slug]/page.tsx"]]) {
    assert.equal(globMatches(pattern, file), true);
    assert.equal(matchesGlob(file, eslintGlobs([pattern])[0]), true, pattern);
  }
});
