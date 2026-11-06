import { globMatches } from "../shared/glob.mjs";

const text = { type: "string", minLength: 1 };
const flag = { type: "boolean" };
const list = (items, minItems = 0) => ({ type: "array", items, minItems });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const strings = list(text);
const files = list(text, 1);
const glob = { ...text, format: "glob" };
const patterns = list(glob, 1);
const regex = { ...text, format: "regex" };
const ruleRoot = { root: text };
const imported = object({ from: text, name: { ...text, pattern: "^(?:default|[A-Za-z_$][A-Za-z0-9_$]*)$" } }, ["from", "name"]);
export const errorHandlingSchema = object({ files: patterns, factories: list(imported, 1), result: imported, background: list(imported, 1) });

export const DEFAULT_SOURCE = Object.freeze(["src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]);

// convert Plumb's literal path characters to ESLint globs without changing root or folder scopes
export const eslintGlobs = (patterns) => patterns.map((value) => {
  const raw = value.replaceAll("\\", "/");
  let clean = raw.replace(/^(?:\.\/)+/, "").replace(/\/{2,}/g, "/");
  if (!clean || clean === ".") return "**";
  if (clean.endsWith("/")) clean += "**";
  return clean.replace(/[\[\]()]/g, (character) => `[${character}]`);
});

export const ruleSchemas = {
  "plumb/layers": object({
    ...ruleRoot,
    layers: list({ type: "array", items: [regex, { type: "number", minimum: 0 }, text], minItems: 3, maxItems: 3 }, 1),
    packages: list(object({ tree: text, source: text, reason: text }, ["tree", "source", "reason"])),
  }, ["layers"]),
  "plumb/owners": object({
    ...ruleRoot,
    rows: list({
      ...object({ owner: list(glob), message: text, importFrom: text, name: text, global: text, member: text, meta: text, now: { const: true }, construct: files, dynamicImport: { const: true }, jsxAttribute: text, value: { type: "string" } }, ["owner", "message"]),
      anyOf: ["global", "member", "meta", "now", "construct", "dynamicImport", "jsxAttribute"].map((name) => ({ required: [name] })).concat([{ required: ["importFrom", "name"] }]),
    }, 1),
  }, ["rows"]),
  "plumb/export-prefix": object({
    ...ruleRoot,
    map: list(object({ match: regex, names: strings, singular: { enum: [true, false, "both"] } }, ["match", "names"]), 1),
    aliases: { type: "object", additionalProperties: text },
    kinds: list({ enum: ["camel", "pascal", "constant"] }, 1),
    exceptions: list(object({ file: text, names: files, reason: text }, ["file", "names", "reason"])),
    skip: list(object({ files: patterns, names: regex }, ["files", "names"])),
    types: flag,
  }, ["map"]),
  "plumb/literal-calls": object({ calls: list(object({ callee: regex, args: list({ enum: ["literal", "literal?", "literal-object", "literal-array"] }), moduleScope: flag }, ["callee", "args"]), 1) }, ["calls"]),
  "plumb/chained-call": object({ object: text, methods: files, chain: text }, ["object", "methods", "chain"]),
  "plumb/keyed-numbers": object({ keys: files, message: text }, ["keys"]),
  "plumb/plain-module": {
    ...object({ packages: regex, specifiers: regex, extensions: files, reason: text }, ["reason"]),
    anyOf: [{ required: ["packages"] }, { required: ["specifiers"] }, { required: ["extensions"] }],
  },
  "plumb-react/tokens": object({ allow: strings }),
  "plumb-react/class-set": object({ physical: flag, joins: flag, variants: flag, inline: flag }),
};

// ESLint's validator does not register Plumb's path formats; the policy validator checks those
export const eslintRuleSchema = (name) => [JSON.parse(JSON.stringify(ruleSchemas[name], (key, value) => key === "format" ? undefined : value))];

const noOptions = ["plumb/class-style", "plumb-react/client-directive", "plumb-react/words", "plumb-react/lines"];

export const configurableRules = new Set([...Object.keys(ruleSchemas), ...noOptions]);

export const optionSchema = object({
  root: text,
  profile: { enum: ["backend", "react"] },
  source: patterns,
  logCalls: regex,
  errorFactory: object({ message: text, allowIn: patterns }, ["message"]),
  errorHandling: errorHandlingSchema,
  tailwind: object({ files: patterns }),
  clientDirective: patterns,
  words: patterns,
  lines: patterns,
  syntax: list(object({ files: patterns, selectors: list(object({ selector: text, message: text }, ["selector", "message"]), 1) }, ["selectors"])),
  rules: list(object({ files: patterns, rules: { type: "object", minProperties: 1, additionalProperties: true } }, ["rules"])),
});

export const validateSchema = (value, schema, location = "javascript") => {
  const fail = (detail) => { throw new TypeError(`${location}: ${detail}`); };
  if (schema === true) return value;
  if (schema === false) fail("is not supported");
  if (schema.const !== undefined && value !== schema.const) fail(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
  if (schema.anyOf && !schema.anyOf.some((choice) => {
    try { validateSchema(value, choice, location); return true; } catch { return false; }
  })) fail("does not match any allowed shape");
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && kind !== schema.type) fail(`must be ${schema.type}`);
  if (schema.required) {
    for (const key of schema.required) if (kind !== "object" || !Object.hasOwn(value, key)) fail(`requires ${key}`);
  }
  if (kind === "object" && schema.type === "object") {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("must be a plain object");
    if (schema.minProperties && Object.keys(value).length < schema.minProperties) fail("must not be empty");
    for (const [key, entry] of Object.entries(value)) {
      const child = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : schema.additionalProperties;
      if (!child) fail(`unknown option ${key}`);
      validateSchema(entry, child, `${location}.${key}`);
    }
  }
  if (kind === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`requires at least ${schema.minItems} entries`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`allows at most ${schema.maxItems} entries`);
    if (schema.items) value.forEach((entry, index) => validateSchema(entry, Array.isArray(schema.items) ? schema.items[index] : schema.items, `${location}[${index}]`));
  }
  if (kind === "string") {
    if (schema.minLength && value.trim().length < schema.minLength) fail("must be a nonempty string");
    if (value.includes("\0")) fail("must not contain a NUL character");
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`must match ${schema.pattern}`);
    if (schema.format === "regex") {
      try { new RegExp(value); } catch { fail("must be a valid regular expression"); }
    }
    if (schema.format === "glob") {
      try { globMatches(value, "probe"); } catch { fail("must be a supported project-relative glob"); }
    }
  }
  if (kind === "number" && (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum))) fail(`must be a finite number at least ${schema.minimum ?? 0}`);
  return value;
};

export const validateOptions = (options = {}) => {
  validateSchema(options, optionSchema);
  const presetRules = new Set();
  if (options.tailwind) ["plumb-react/tokens", "plumb-react/class-set"].forEach((name) => presetRules.add(name));
  for (const [key, name] of [["clientDirective", "client-directive"], ["words", "words"], ["lines", "lines"]]) {
    if (options[key]) presetRules.add(`plumb-react/${name}`);
  }
  for (const [index, block] of (options.rules ?? []).entries()) {
    for (const [name, setting] of Object.entries(block.rules)) {
      const location = `javascript.rules[${index}].rules.${name}`;
      if (!configurableRules.has(name) || presetRules.has(name)) throw new TypeError(`${location}: cannot reconfigure a preset rule; only supported opt-in contracts may be added`);
      const array = Array.isArray(setting) ? setting : [setting];
      if (!["error", 2].includes(array[0])) throw new TypeError(`${location}: every rule must be an error`);
      const schema = ruleSchemas[name];
      if (array.length > (schema ? 2 : 1)) throw new TypeError(`${location}: unsupported rule options`);
      if (schema) {
        validateSchema(array[1] ?? {}, schema, location);
        if (Object.hasOwn(array[1] ?? {}, "root")) throw new TypeError(`${location}: root is supplied by the project, never by a rule`);
      }
    }
  }
  return options;
};

export const scopeProblems = (options, relativeFiles) => {
  const scopes = [];
  if (!relativeFiles.length && Object.keys(options).some((key) => !["root", "profile"].includes(key))) {
    return ["javascript: configured language contracts have no selected JavaScript or TypeScript source"];
  }
  const add = (name, patterns) => scopes.push([`javascript.${name}`, patterns]);
  if (options.source) add("source", options.source);
  if (options.errorFactory?.allowIn) add("errorFactory.allowIn", options.errorFactory.allowIn);
  if (options.errorHandling) add("errorHandling.files", options.errorHandling.files ?? ["."]);
  if (options.tailwind) add("tailwind.files", options.tailwind.files ?? options.source ?? DEFAULT_SOURCE);
  for (const name of ["clientDirective", "words", "lines"]) if (options[name]) add(name, options[name]);
  (options.syntax ?? []).forEach((row, index) => add(`syntax[${index}].files`, row.files ?? ["."]));
  (options.rules ?? []).forEach((row, index) => add(`rules[${index}].files`, row.files ?? ["."]));
  return scopes.filter(([_name, patterns]) => !relativeFiles.some((file) => globMatches(patterns, file))).map(([name]) => `${name}: matches no selected source files; correct or remove the unused scope`);
};
