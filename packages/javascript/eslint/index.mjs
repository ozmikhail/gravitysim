import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";
import tseslint from "typescript-eslint";

import { createModuleResolver } from "../shared/module-resolver.mjs";
import { customRuleMetadata } from "./metadata.mjs";
import { DEFAULT_SOURCE, eslintGlobs, validateOptions } from "./options.mjs";
import { plumbReactRules } from "./react.mjs";
import { plumbTypescriptRules } from "./rules.mjs";
import { scopedRule } from "./scoped.mjs";
import { syntaxRule } from "./syntax.mjs";
import { errorHandlingRule } from "./errors.mjs";
import { typeCheckedRules, typeInformationRule } from "./typed-policy.mjs";
export { strictCompilerOptions, typedRuntime } from "./typed.mjs";

const SCRIPTS = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const TYPED = "**/*.{ts,tsx,mts,cts}";
export const PLUMB_MAX_LINES = Object.freeze({ max: 400, skipBlankLines: true, skipComments: true });

const namingConvention = (react) => [
  "error",
  { selector: "typeLike", format: ["PascalCase"] },
  { selector: "function", format: react ? ["camelCase", "PascalCase"] : ["camelCase"], leadingUnderscore: "allow" },
  { selector: "parameter", format: ["camelCase"], leadingUnderscore: "allow" },
  {
    selector: "variable",
    format: ["camelCase", "UPPER_CASE", "PascalCase"],
    ...(react ? { leadingUnderscore: "allowSingleOrDouble", trailingUnderscore: "allowDouble" } : { leadingUnderscore: "allow" }),
  },
];

const baseRules = (react) => ({
  curly: ["error", "all"],
  "no-console": "error",
  "no-empty": ["error", { allowEmptyCatch: false }],
  "no-throw-literal": "error",
  "prefer-promise-reject-errors": ["error", { allowEmptyReject: false }],
  "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
  "simple-import-sort/imports": "error",
  "simple-import-sort/exports": "error",
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
  "@typescript-eslint/naming-convention": namingConvention(react),
  "plumb/comments": "error",
  "plumb/directive": "error",
  "plumb/imports-first": "error",
  "plumb/module-spacing": "error",
});

const typedRules = (profile) => ({
  "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
  "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
  "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/no-import-type-side-effects": "error",
  ...(profile === "backend" && { "@typescript-eslint/explicit-module-boundary-types": "error" }),
});

const reactRules = () => ({
  ...Object.fromEntries(Object.keys(reactHooks.configs["recommended-latest"].rules).map((name) => [name, "error"])),
  "plumb-react/props": "error",
  "plumb-react/refresh-boundary": "error",
});

export const plumbEslint = (input = {}, runtime = {}) => {
  validateOptions(input);
  if (!input.root) throw new TypeError("plumbEslint: root is the absolute project folder");
  const { root, profile = "backend", source = DEFAULT_SOURCE, rules = [], tailwind, clientDirective, words, lines } = input;
  const react = profile === "react";
  const syntax = { ...input, root, profile, source };
  const pluginRules = { plumb: { ...plumbTypescriptRules, syntax: syntaxRule, errors: errorHandlingRule, "type-information": typeInformationRule }, "plumb-react": { ...plumbReactRules } };
  const contracts = {};
  for (const block of rules) {
    for (const [id, setting] of Object.entries(block.rules)) {
      const [namespace, name] = id.split("/");
      const values = Array.isArray(setting) ? setting.slice(1) : [];
      const options = ["layers", "owners", "export-prefix"].includes(name) ? [{ ...values[0], root }] : values;
      (contracts[id] ??= ["error", []])[1].push({ files: block.files ?? [SCRIPTS], options });
      pluginRules[namespace][name] = scopedRule((namespace === "plumb" ? plumbTypescriptRules : plumbReactRules)[name], root);
    }
  }
  return defineConfig(
    { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error", reportUnusedInlineConfigs: "error" } },
    {
      files: [SCRIPTS],
      extends: [js.configs.recommended, ...tseslint.configs.recommended],
      languageOptions: { ecmaVersion: 2022, globals: react ? { ...globals.browser, ...globals.node } : { ...globals.node } },
      settings: { plumbResolver: runtime.resolver ?? createModuleResolver(root), plumbTyped: runtime.typed, plumbTrustedPrograms: runtime.programs ?? [] },
      plugins: { plumb: { rules: pluginRules.plumb }, "plumb-react": { rules: pluginRules["plumb-react"] }, "react-hooks": reactHooks, "simple-import-sort": simpleImportSort },
      rules: { ...baseRules(react), ...(react && reactRules()), "plumb/syntax": ["error", syntax], "plumb/errors": ["error", { ...input.errorHandling, root }], ...contracts },
    },
    { files: [TYPED], rules: typedRules(profile) },
    { files: [TYPED], rules: { "plumb/type-information": "error" } },
    ...(runtime.programs?.length && runtime.typedFiles?.length ? [{
      files: eslintGlobs(runtime.typedFiles),
      languageOptions: { parserOptions: { programs: runtime.programs, project: false, projectService: false, tsconfigRootDir: root } },
      rules: { ...typeCheckedRules, "no-throw-literal": "off", "prefer-promise-reject-errors": "off", "plumb/type-information": "error" },
    }] : []),
    { files: eslintGlobs(source), rules: { "max-lines": ["error", PLUMB_MAX_LINES] } },
    ...(tailwind ? [{ files: eslintGlobs(tailwind.files ?? source), rules: { "plumb-react/tokens": "error", "plumb-react/class-set": ["error", { physical: true, joins: true, variants: true, inline: true }] } }] : []),
    ...(clientDirective ? [{ files: eslintGlobs(clientDirective), rules: { "plumb-react/client-directive": "error" } }] : []),
    ...(words ? [{ files: eslintGlobs(words), rules: { "plumb-react/words": "error" } }] : []),
    ...(lines ? [{ files: eslintGlobs(lines), rules: { "plumb-react/lines": "error" } }] : []),
  );
};

export const createConfig = plumbEslint;
export { scopeProblems, validateOptions } from "./options.mjs";

export const ruleMetadata = Object.freeze([
  ...customRuleMetadata,
  ...[...new Set([
    ...Object.keys(js.configs.recommended.rules),
    ...tseslint.configs.recommended.flatMap((config) => Object.keys(config.rules ?? {})),
    ...Object.keys(baseRules(true)),
    ...Object.keys(typedRules("backend")),
    ...Object.keys(typeCheckedRules),
    ...Object.keys(reactRules()),
    "max-lines",
  ])].filter((name) => !name.startsWith("plumb/") && !name.startsWith("plumb-react/")).sort().map((name) => ({
    id: `javascript/${name}`,
    rule: name,
    family: "lint",
    description: `Enforces the release's ${name} rule.`,
    remedy: `Resolve the ${name} diagnostic without weakening the preset.`,
    configurable: false,
    suppressible: true,
    fix: null,
  })),
]);

export const getRuleMetadata = () => ruleMetadata;
