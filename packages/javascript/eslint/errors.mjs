import { globMatches } from "../shared/glob.mjs";
import { effectOrigins, unwrapExpression } from "./effects.mjs";
import { rulesRelativeTo } from "./rules/shared.mjs";

const empty = (body) => body?.type === "BlockStatement" && body.body.every((item) => item.type === "EmptyStatement");
export const errorHandlingRule = {
  meta: {
    type: "problem", schema: [{ type: "object" }],
    messages: {
      empty: "Handle, translate or rethrow the failure; an empty catch cannot silently discard it.",
      thrown: "Throw an Error value, never a primitive, object literal or array.",
      factory: "Create thrown errors through an approved imported factory, or rethrow a caught Error after narrowing it.",
      resultThrow: "This scope returns its approved Result type; explicit throws violate that error convention.",
      result: "Exported callable {{name}} must return the approved Result type, directly or through Promise.",
      background: "Await or return asynchronous work, or pass one async callback to an approved imported background wrapper returning void.",
      unresolved: "Cannot verify the configured error or async convention: {{detail}}",
    },
  },
  create(context) {
    const { root = context.cwd, ...configured } = context.options[0] ?? {};
    const selected = !configured.files || globMatches(configured.files, rulesRelativeTo(root, context.filename));
    const policy = selected ? configured : {}, typed = context.settings?.plumbTyped, effects = effectOrigins(context);
    const requiresTypes = !!(policy.factories || policy.result || policy.background);
    let ready = false;
    const report = (node, messageId, detail) => context.report({ node, messageId, ...(detail ? { data: { detail } } : {}) });
    const approved = (node, references) => {
      const values = references.map((reference) => typed.matches(context, node, reference));
      return values.includes(true) ? true : values.includes(undefined) ? undefined : false;
    };
    return {
      Program(node) {
        ready = !!(context.sourceCode.parserServices?.program && typed);
        if (requiresTypes && !ready) report(node, "unresolved", "a trusted typed Program is required for this scope");
      },
      CatchClause(node) { if (empty(node.body)) report(node, "empty"); },
      ThrowStatement(node) {
        const value = unwrapExpression(node.argument);
        if (["Literal", "TemplateLiteral", "ObjectExpression", "ArrayExpression"].includes(value?.type)) report(node, "thrown");
        if (policy.result) { report(node, "resultThrow"); return; }
        if (!policy.factories || !ready) return;
        if (effects.origins(value).some((origin) => origin.caught && !origin.uncertain)) return;
        const created = effects.initialization(value);
        const match = created?.type === "CallExpression" ? approved(created.callee, policy.factories) : false;
        if (match !== true) report(node, match === undefined ? "unresolved" : "factory", match === undefined ? "the approved factory symbol could not be resolved" : undefined);
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (callee?.type === "MemberExpression" && ((!callee.computed && callee.property.name === "catch") || effects.literal(callee.property) === "catch") && typed?.promise(context, callee.object) === true && empty(node.arguments[0]?.body)) report(node, "empty");
        if (!policy.background || !ready) return;
        const match = approved(node.callee, policy.background);
        if (match !== true) return;
        const shape = typed.background(context, node);
        if (!shape) report(node, "unresolved", "the background wrapper's argument and return types are unresolved");
        else if (!shape.voidReturn || !shape.asyncArgument) report(node, "background");
      },
      ExpressionStatement(node) {
        if (!policy.background || !ready) return;
        const expression = unwrapExpression(node.expression), value = expression?.type === "UnaryExpression" && expression.operator === "void" ? unwrapExpression(expression.argument) : expression;
        if (!value || value.type === "AwaitExpression") return;
        const promise = typed.promise(context, value);
        if (promise === true) { report(node, "background"); return; }
        if (value.type !== "CallExpression") return;
        const shape = typed.background(context, value), match = approved(value.callee, policy.background);
        if (shape?.voidReturn && shape.asyncArgument && match !== true) report(node, match === undefined ? "unresolved" : "background", match === undefined ? "the background wrapper symbol could not be resolved" : undefined);
      },
      "Program:exit"(node) {
        if (!policy.result || !ready) return;
        const exports = typed.resultExports(context, policy.result);
        if (!exports) { report(node, "unresolved", "the approved Result type or module exports could not be resolved"); return; }
        for (const exported of exports) {
          if (exported.unresolved) report(node, "unresolved", `the return type of ${exported.name} is unresolved`);
          else if (!exported.valid) context.report({ node, messageId: "result", data: { name: exported.name } });
        }
      },
    };
  },
};
