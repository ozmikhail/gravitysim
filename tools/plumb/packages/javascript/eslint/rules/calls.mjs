import { eslintRuleSchema } from "../options.mjs";

const isPhrase = (node) =>
  (node?.type === "Literal" && typeof node.value === "string") ||
  (node?.type === "TemplateLiteral" && node.expressions.length === 0);

// an argument shape: a literal, an optional one, an object of literals or an array of them
const SHAPES = {
  literal: (node) => isPhrase(node),
  "literal?": (node) => node === undefined || isPhrase(node),
  "literal-object": (node) =>
    node?.type === "ObjectExpression" &&
    node.properties.every((entry) => entry.type === "Property" && !entry.computed && isPhrase(entry.value)),
  "literal-array": (node) =>
    node?.type === "ArrayExpression" && node.elements.every((entry) => isPhrase(entry)),
};

const calleeName = (node) =>
  node.callee.type === "Identifier"
    ? node.callee.name
    : node.callee.type === "MemberExpression" && !node.callee.computed
      ? node.callee.property.name
      : undefined;

// calls: rows of { callee, args, moduleScope }; callee is a pattern, args name each shape in order
const literalCallsRule = {
  meta: {
    type: "problem",
    schema: eslintRuleSchema("plumb/literal-calls"),
    messages: {
      literal: "{{callee}} states its arguments as literals ({{args}}), so each key is on the page",
      scope: "{{callee}} is called at module scope, so boot sees every value it registers",
    },
  },
  create(context) {
    const rows = (context.options[0]?.calls ?? []).map((row) => ({
      ...row,
      pattern: new RegExp(row.callee),
    }));
    return {
      CallExpression(node) {
        const name = calleeName(node);
        const row = name && rows.find((entry) => entry.pattern.test(name));
        if (!row) {
          return;
        }
        const extra = node.arguments.length > row.args.length;
        const shaped = row.args.every((shape, index) => SHAPES[shape]?.(node.arguments[index]));
        if (extra || !shaped) {
          context.report({
            node,
            messageId: "literal",
            data: { callee: name, args: row.args.join(", ") },
          });
        }
        if (
          row.moduleScope &&
          context.sourceCode
            .getAncestors(node)
            .some((ancestor) => ancestor.type.includes("Function") ||
              (["PropertyDefinition", "AccessorProperty"].includes(ancestor.type) && !ancestor.static))
        ) {
          context.report({ node, messageId: "scope", data: { callee: name } });
        }
      },
    };
  },
}; // a registry read at boot holds values a reader can find by searching for them

const isChainedBy = (node, chain) => {
  const member = node.parent;
  return (
    member?.type === "MemberExpression" &&
    member.object === node &&
    !member.computed &&
    member.property.name === chain &&
    member.parent?.type === "CallExpression" &&
    member.parent.callee === member
  );
};

// object.method(...) for the listed methods is always followed by .chain(...)
const chainedCallRule = {
  meta: {
    type: "problem",
    schema: eslintRuleSchema("plumb/chained-call"),
    messages: { chain: "{{object}}.{{method}}(...) is followed by .{{chain}}(...) in this module" },
  },
  create(context) {
    const { object, methods = [], chain } = context.options[0] ?? {};
    const listed = new Set(methods);
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.object.type !== "Identifier" ||
          callee.object.name !== object ||
          !listed.has(callee.property.name)
        ) {
          return;
        }
        const branch = node.parent?.type === "ConditionalExpression" && node.parent.test !== node; // a ternary may choose the call it chains
        if (!isChainedBy(node, chain) && !(branch && isChainedBy(node.parent, chain))) {
          context.report({
            node,
            messageId: "chain",
            data: { object, method: callee.property.name, chain },
          });
        }
      },
    };
  },
};

export const plumbCallRules = {
  "chained-call": chainedCallRule,
  "literal-calls": literalCallsRule,
};
