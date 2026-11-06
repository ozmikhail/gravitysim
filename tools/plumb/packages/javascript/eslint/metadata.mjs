import { configurableRules } from "./options.mjs";
import { plumbReactRules } from "./react.mjs";
import { plumbTypescriptRules } from "./rules.mjs";
import { syntaxRule } from "./syntax.mjs";
import { errorHandlingRule } from "./errors.mjs";
import { typeInformationRule } from "./typed-policy.mjs";

const descriptions = {
  comments: ["files", "Use short explanatory line comments with the preset's spacing and casing."],
  directive: ["policy", "Move narrow, reasoned exceptions into plumb.json; inline tool suppressions cannot change policy."],
  "class-style": ["files", "Organize the configured library behavior in a class and export bound methods."],
  "imports-first": ["files", "Move imports manually while preserving dependency evaluation order."],
  "module-spacing": ["files", "Separate module sections and class methods with a blank line."],
  "export-prefix": ["exports", "Use the owning module's configured prefix in exported names."],
  layers: ["boundaries", "Import only permitted layers and public areas; resolve every local edge."],
  owners: ["ownership", "Access each governed API through its configured owner."],
  "literal-calls": ["calls", "State registration arguments in the required literal shapes and scope."],
  "chained-call": ["calls", "Follow each configured factory call with the required method."],
  "keyed-numbers": ["values", "Put configured numeric properties behind named tokens."],
  "plain-module": ["boundaries", "Keep dependencies compatible with the module's plain loader."],
  syntax: ["calls", "Follow every syntax restriction that applies to this file."],
  errors: ["errors", "Handle failures, use approved error/result contracts and route detached async work through an approved wrapper."],
  "type-information": ["types", "Provide a trusted compiler Program covering this exact source before completing typed lint checks."],
  props: ["exports", "Give a component's props a named interface."],
  "refresh-boundary": ["exports", "Keep component exports separate from other runtime exports."],
  "client-directive": ["boundaries", "Review the client boundary and declare it explicitly; existing boundaries are preserved."],
  tokens: ["values", "Use named color tokens instead of raw palette values."],
  "class-set": ["values", "Use logical directions and module-scope class recipes."],
  words: ["values", "Move visible text to the project's catalogue."],
  lines: ["values", "Keep catalogue strings to a single clear line within the configured limit."],
};

export const customRuleMetadata = Object.freeze(
  Object.entries({ plumb: { ...plumbTypescriptRules, syntax: syntaxRule, errors: errorHandlingRule, "type-information": typeInformationRule }, "plumb-react": plumbReactRules }).flatMap(([namespace, rules]) =>
    Object.entries(rules).map(([name, rule]) => ({
      id: `javascript/${namespace}/${name}`,
      rule: `${namespace}/${name}`,
      family: descriptions[name][0],
      description: descriptions[name][1],
      remedy: descriptions[name][1],
      schema: rule.meta.schema,
      configurable: configurableRules.has(`${namespace}/${name}`),
      suppressible: !["directive", "type-information"].includes(name),
      fix: rule.meta.fixable === "whitespace" ? "whitespace" : null,
    })),
  ),
);
