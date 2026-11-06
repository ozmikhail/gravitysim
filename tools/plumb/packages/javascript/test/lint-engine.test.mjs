import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { ESLint, Linter } from "eslint";
import globals from "globals";
import ts from "typescript";
import tseslint from "typescript-eslint";

import { createConfig, getRuleMetadata } from "../eslint/index.mjs";
import { plumbReactRules } from "../eslint/react.mjs";
import { plumbTypescriptRules } from "../eslint/rules.mjs";
import { createModuleResolver } from "../shared/module-resolver.mjs";

let root;
before(async () => {
  root = await mkdtemp(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-lint-engine-"));
  for (const [file, code] of [
    ["src/lib/helper.ts", "export const helper = 1;\n"],
    ["src/state/card.tsx", "export const Card = () => null;\n"],
    ["src/index.js", "export const value = 1;\n"],
    ["src/package/index.ts", "export const item = 1;\n"],
    ["src/runtime.d.ts", "export declare const value: number;\n"],
    ["src/runtime.js", "export const value = 1;\n"],
    ["src/declaration-only.d.ts", "export declare const value: number;\n"],
  ]) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, code);
  }
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const isolated = (rule, code, options, file = "src/module.ts") => {
  const linter = new Linter({ configType: "flat", cwd: root });
  const config = [{
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } }, globals: { ...globals.node, ...globals.browser } },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off" },
    plugins: { plumb: { rules: plumbTypescriptRules }, "plumb-react": { rules: plumbReactRules } },
    rules: { [rule]: options === undefined ? "error" : ["error", options] },
  }];
  const filename = join(root, file);
  const messages = linter.verify(code, config, { filename });
  assert.ok(!messages.some((message) => message.fatal), JSON.stringify(messages));
  return { messages: messages.filter((message) => message.ruleId === rule), output: linter.verifyAndFix(code, config, { filename }).output };
};

const cases = [
  ["plumb/comments", "// a short reason\nexport const value = 1;\n", "// Capital sentence\nexport const value = 1;\n"],
  ["plumb/directive", "export const value = 1;\n", "export const value = 1; // eslint-disable-line no-console -- someone asked\n"],
  ["plumb/class-style", "class Clock { now() { return 1; } }\nconst clock = new Clock();\nexport const clockNow = clock.now.bind(clock);\n", "export const clockNow = () => 1;\n"],
  ["plumb/imports-first", 'import "./lib/helper";\nexport const value = 1;\n', 'export const value = 1;\nimport "./lib/helper";\n'],
  ["plumb/module-spacing", 'import "./lib/helper";\n\nexport const value = 1;\n', 'import "./lib/helper";\nexport const value = 1;\n'],
  ["plumb/export-prefix", "export const moduleValue = 1;\n", "export const wrongName = 1;\n", () => ({ root, map: [{ match: "^src/", names: ["$file"] }] })],
  ["plumb/owners", "export const value = 1;\n", "export const value = fetch('/');\n", () => ({ root, rows: [{ global: "fetch", owner: ["src/network.ts"], message: "use the network owner" }] })],
  ["plumb/literal-calls", 'export const value = register("known");\n', "export const value = register(unknown);\n", () => ({ calls: [{ callee: "^register$", args: ["literal"], moduleScope: true }] })],
  ["plumb/chained-call", "export const value = Factory.create().explain();\n", "export const value = Factory.create();\n", () => ({ object: "Factory", methods: ["create"], chain: "explain" })],
  ["plumb/keyed-numbers", "export const value = { delay: PACE };\n", "export const value = { delay: 0.4 };\n", () => ({ keys: ["delay"] })],
  ["plumb/plain-module", "export const value = 1;\n", 'import "forbidden-package";\n', () => ({ packages: "^forbidden-package$", reason: "the build loads this file" })],
  ["plumb-react/props", "interface CardProps { value: number }\nexport const Card = ({ value }: CardProps) => <p>{value}</p>;\n", "export const Card = ({ value }: { value: number }) => <p>{value}</p>;\n", undefined, "src/card.tsx"],
  ["plumb-react/refresh-boundary", "export const Card = () => <p />;\nexport type CardSize = number;\n", "export const Card = () => <p />;\nexport const size = 1;\n", undefined, "src/card.tsx"],
  ["plumb-react/client-directive", '"use client";\nexport const Card = () => <p />;\n', "export const Card = () => <p />;\n", undefined, "src/card.tsx"],
  ["plumb-react/tokens", 'export const color = "bg-surface";\n', 'export const color = "bg-red-500";\n'],
  ["plumb-react/class-set", 'export const cardVariants = tv({ base: "ms-2" });\n', 'export const cardVariants = tv({ base: "ml-2" });\n', () => ({ physical: true, variants: true })],
  ["plumb-react/words", "export const Card = () => <p>{copy.greeting}</p>;\n", 'export const Card = () => <p>{"Hello world"}</p>;\n', undefined, "src/card.tsx"],
  ["plumb-react/lines", 'export const copy = { title: "Clear words" };\n', `export const copy = { title: "${"a".repeat(81)}" };\n`],
];

for (const [rule, pass, refuse, options, file] of cases) {
  test(`${rule}: passing and refused code`, () => {
    const selected = options?.();
    assert.equal(isolated(rule, pass, selected, file).messages.length, 0, rule);
    assert.ok(isolated(rule, refuse, selected, file).messages.length > 0, rule);
  });
}

test("layers use actual TSX, JavaScript extension substitution, and directory resolution", () => {
  const options = { root, layers: [["^src/lib/", 1, "lib"], ["^src/state/.*\\.tsx$", 2, "state"]] };
  assert.equal(isolated("plumb/layers", 'import { helper } from "../lib/helper";\nexport const value = helper;\n', options, "src/state/time.tsx").messages.length, 0);
  for (const target of ["../state/card", "../state/card.js", "../state/card.tsx"]) {
    assert.equal(isolated("plumb/layers", `import { Card } from "${target}";\nexport const value = Card;\n`, options, "src/lib/adapter.ts").messages[0].messageId, "up");
  }
  assert.equal(isolated("plumb/layers", 'import "./missing";\n', options, "src/lib/adapter.ts").messages[0].messageId, "unresolved");
  const resolver = createModuleResolver(root);
  assert.equal(resolver.resolve(join(root, "src/start.ts"), "./package"), join(root, "src/package/index.ts"));
  assert.equal(resolver.resolve(join(root, "src/start.ts"), "./index"), join(root, "src/index.js"));
});

test("inline type imports preserve emitted runtime edges for layer and loader checks", () => {
  const inline = 'import { type Card } from "../state/card";\n';
  const erased = 'import type { Card } from "../state/card";\n';
  const compilerOptions = { verbatimModuleSyntax: true, module: ts.ModuleKind.ESNext };
  assert.ok(ts.transpileModule(inline, { compilerOptions }).outputText.includes("../state/card"));
  assert.ok(!ts.transpileModule(erased, { compilerOptions }).outputText.includes("../state/card"));
  const layers = { root, layers: [["^src/lib/", 1, "lib"], ["^src/state/", 2, "state"]] };
  const loader = { extensions: [".tsx"], reason: "the loader cannot execute components" };
  for (const [rule, options, messageId] of [["plumb/layers", layers, "up"], ["plumb/plain-module", loader, "refused"]]) {
    assert.equal(isolated(rule, inline, options, "src/lib/adapter.ts").messages[0].messageId, messageId);
    assert.equal(isolated(rule, erased, options, "src/lib/adapter.ts").messages.length, 0);
  }
});

test("TS config paths resolve through the same resolver and malformed configs fail", async () => {
  const folder = join(root, "aliases");
  await mkdir(join(folder, "src"), { recursive: true });
  await writeFile(join(folder, "src/card.ts"), "export const card = 1;\n");
  const config = join(folder, "tsconfig.json");
  await writeFile(config, JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", paths: { "@/*": ["./src/*"] } }, include: ["src/**"] }));
  const resolver = createModuleResolver(folder);
  const from = join(folder, "src/main.ts");
  assert.equal(resolver.resolve(from, "@/card"), join(folder, "src/card.ts"));
  assert.equal(resolver.isLocal(from, "@/missing"), true);
  await writeFile(config, '{ "extends": "./missing-config.json" }');
  assert.throws(() => createModuleResolver(folder).resolve(from, "@/card"), /missing-config/);
});

test("declarations cannot hide the runtime dependency from a loader contract", () => {
  const resolver = createModuleResolver(root);
  const from = join(root, "src/entry.ts");
  assert.equal(resolver.resolve(from, "./runtime"), join(root, "src/runtime.d.ts"));
  assert.equal(resolver.runtime(from, "./runtime"), join(root, "src/runtime.js"));
  assert.equal(resolver.runtime(from, "./declaration-only"), undefined);
  const options = { extensions: [".js"], reason: "a source-only loader runs here" };
  assert.equal(isolated("plumb/plain-module", 'import "./runtime";\n', options).messages[0].messageId, "refused");
  assert.equal(isolated("plumb/plain-module", 'import "./declaration-only";\n', options).messages[0].messageId, "unresolved");
});

test("unsafe layout and client transformations never appear in ESLint fixes", () => {
  const code = 'export { ready } from "./initialize";\nimport "./consume";\n';
  assert.equal(isolated("plumb/imports-first", code).output, code);
  const boundary = '"use client";\nexport { Carousel } from "third-party-carousel";\n';
  assert.equal(isolated("plumb-react/client-directive", boundary).output, boundary);
  const component = "export const Card = () => <p />;\n";
  assert.equal(isolated("plumb-react/client-directive", component, undefined, "src/card.tsx").output, component);
});

test("ownership covers bare imports, namespace imports, re-exports, require, and renamed process imports", () => {
  const options = { root, rows: [{ importFrom: "raw-api", name: "*", owner: ["src/owner.ts"], message: "use the owner" }, { member: "process.env", owner: ["src/config.ts"], message: "use config" }] };
  for (const code of ['import "raw-api";', 'import * as api from "raw-api";', 'export { value } from "raw-api";', 'export * from "raw-api";', 'const api = require("raw-api");', 'const load = () => import("raw-api");', 'import proc from "node:process"; const value = proc.env;']) {
    assert.ok(isolated("plumb/owners", code, options).messages.length > 0, code);
  }
  assert.equal(isolated("plumb/owners", 'import "raw-api";', options, "src/owner.ts").messages.length, 0);
});

const preset = async (code, options = {}, file = "src/module.ts") => {
  const engine = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: createConfig({ root, ...options }) });
  const [result] = await engine.lintText(code, { filePath: join(root, file) });
  assert.ok(!result.messages.some((message) => message.fatal), JSON.stringify(result.messages));
  return result.messages;
};

test("the full preset enforces inherited rules and ignores candidate inline attempts", async () => {
  const messages = await preset("/* eslint-disable */\nconsole.log('attempt');\n");
  assert.ok(messages.some((message) => message.ruleId === "no-console"));
  assert.ok(messages.some((message) => message.ruleId === "plumb/directive"));
  assert.throws(() => createConfig({ root, rules: [{ extends: [{ rules: { "no-debugger": "off" } }] }] }), /unknown option/);
});

test("the full preset preserves backend return types and component naming", async () => {
  const code = "export const read = (value: number) => value;\n";
  assert.ok((await preset(code)).some((message) => message.ruleId === "@typescript-eslint/explicit-module-boundary-types"));
  assert.ok(!(await preset(code, { profile: "react" })).some((message) => message.ruleId === "@typescript-eslint/explicit-module-boundary-types"));
  const component = "export function Card(): null {\n  return null;\n}\n";
  assert.ok(!(await preset(component, { profile: "react" }, "src/card.tsx")).some((message) => message.ruleId === "@typescript-eslint/naming-convention"));
});

test("ratchet files cannot disable max-lines or unrelated React syntax restrictions", async () => {
  await writeFile(join(root, "plumb.ratchet.json"), JSON.stringify({ "max-lines": { reason: "old exemption", files: ["src/long.ts"] } }));
  const code = Array.from({ length: 401 }, (_, index) => `export const value${index} = ${index};`).join("\n") + "\n\nawait Promise.resolve();\n";
  const messages = await preset(code, { profile: "react" }, "src/long.ts");
  assert.ok(messages.some((message) => message.ruleId === "max-lines"));
  assert.ok(messages.some((message) => message.ruleId === "plumb/syntax"));
});

test("explicit root source scopes enforce max-lines outside src", async () => {
  const code = Array.from({ length: 401 }, (_, index) => `export const value${index} = ${index};`).join("\n");
  const messages = await preset(code, { source: ["."] }, "tools/long.ts");
  assert.ok(messages.some((message) => message.ruleId === "max-lines"));
});

test("full ESLint selector execution unions every matching syntax row", async () => {
  const messages = await preset("export const one = 1;\nexport const two = 2;\nexport const three = 3;\n", {
    syntax: [
      { selectors: [{ selector: "Literal[value=1]", message: "global constraint" }] },
      { files: ["src/**"], selectors: [{ selector: "Literal[value=2]", message: "source constraint" }] },
      { files: ["src/module.ts"], selectors: [{ selector: "Literal[value=3]", message: "module constraint" }] },
    ],
  });
  assert.deepEqual(messages.filter((message) => message.ruleId === "plumb/syntax").map((message) => message.message), ["global constraint", "source constraint", "module constraint"]);
});

test("overlapping rule blocks enforce every numeric token contract", async () => {
  const messages = await preset("export const options = { delay: 2, duration: 3 };\n", { rules: [
    { files: ["src/**"], rules: { "plumb/keyed-numbers": ["error", { keys: ["delay"] }] } },
    { files: ["src/module.ts"], rules: { "plumb/keyed-numbers": ["error", { keys: ["duration"] }] } },
  ] });
  assert.equal(messages.filter((message) => message.ruleId === "plumb/keyed-numbers").length, 2);
});

test("rule metadata covers every custom rule and inherited preset identifiers", () => {
  const metadata = getRuleMetadata();
  const ids = new Set(metadata.map((entry) => entry.rule));
  for (const name of Object.keys(plumbTypescriptRules)) assert.ok(ids.has(`plumb/${name}`));
  for (const name of Object.keys(plumbReactRules)) assert.ok(ids.has(`plumb-react/${name}`));
  for (const name of ["no-console", "no-debugger", "max-lines", "@typescript-eslint/no-unused-vars", "plumb/syntax"]) assert.ok(ids.has(name), name);
  assert.equal(metadata.find((entry) => entry.rule === "plumb/directive").suppressible, false);
});
