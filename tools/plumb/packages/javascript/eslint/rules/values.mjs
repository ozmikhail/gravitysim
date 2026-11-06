import path from "node:path";

import { createModuleResolver } from "../../shared/module-resolver.mjs";
import { eslintRuleSchema } from "../options.mjs";

const holdsNumber = (node) => {
  if (!node || typeof node.type !== "string") {
    return false;
  }
  if (node.type === "Literal") {
    return typeof node.value === "number" && node.value !== 0; // zero is no amount
  }
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" && (Array.isArray(value) ? value.some(holdsNumber) : holdsNumber(value)),
  );
};

// keys: the property names whose value comes from a named token, never a number in place
const keyedNumbersRule = {
  meta: {
    type: "suggestion",
    schema: eslintRuleSchema("plumb/keyed-numbers"),
    messages: { token: "{{key}} takes a named token, never a number in place: {{message}}" },
  },
  create(context) {
    const { keys = [], message = "name it once, where its siblings are tuned" } =
      context.options[0] ?? {};
    const listed = new Set(keys);
    return {
      Property(node) {
        const key = node.key.type === "Identifier" ? node.key.name : node.key.value;
        if (listed.has(key) && holdsNumber(node.value)) {
          context.report({ node: node.value, messageId: "token", data: { key, message } });
        }
      },
    };
  },
}; // a tuned value lives in one file, so a change to it is one edit

// a module a plain loader runs imports no refused package or specifier, and no file of a refused kind
const plainModuleRule = {
  meta: {
    type: "problem",
    schema: eslintRuleSchema("plumb/plain-module"),
    messages: {
      refused: "{{source}} is refused here: {{reason}}",
      unresolved: "Cannot verify this loader contract: {{source}} does not resolve",
    },
  },
  create(context) {
    const {
      packages,
      specifiers,
      extensions = [],
      reason = "a plain loader runs this module",
    } = context.options[0] ?? {};
    const packagePattern = packages ? new RegExp(packages) : undefined;
    const specifierPattern = specifiers ? new RegExp(specifiers) : undefined;
    const resolver = context.settings?.plumbResolver ?? createModuleResolver(context.cwd ?? path.dirname(context.filename));
    const refusedFile = (source) => {
      if (extensions.some((extension) => source.endsWith(extension))) return true;
      const target = resolver.runtime(context.filename, source);
      return target !== undefined && extensions.some((extension) => target.endsWith(extension));
    };
    const check = (node, source, typeOnly) => {
      if (
        !typeOnly &&
        (packagePattern?.test(source) || specifierPattern?.test(source) || refusedFile(source))
      ) {
        context.report({ node, messageId: "refused", data: { source, reason } });
      } else if (!typeOnly && resolver.isLocal(context.filename, source) && !resolver.runtime(context.filename, source)) {
        context.report({ node, messageId: "unresolved", data: { source } });
      }
    };
    return {
      ImportDeclaration(node) {
        // inline type specifiers keep an empty runtime import under verbatimModuleSyntax
        check(node, node.source.value, node.importKind === "type");
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          check(node, node.source.value, node.exportKind === "type");
        }
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value, node.exportKind === "type");
      },
    };
  },
};

export const plumbValueRules = {
  "keyed-numbers": keyedNumbersRule,
  "plain-module": plainModuleRule,
};
