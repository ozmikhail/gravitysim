import { globMatches } from "../shared/glob.mjs";
import { eslintRuleSchema } from "./options.mjs";
import { rulesRelativeTo } from "./rules/shared.mjs";
import { effectOrigins, isValueReference, variableOf } from "./effects.mjs";

const importsFrom = (row, source) => row.importFrom === source || row.name === "*" && source.startsWith(`${row.importFrom}/`);
const host = (origin) => {
  let name = origin.global ?? origin.module?.replace(/^node:/, ""), path = origin.path;
  if (origin.module && path[0] === "default") path = path.slice(1);
  if (origin.global && ["window", "globalThis", "self"].includes(name) && path.length) { name = path[0]; path = path.slice(1); }
  return [name, ...path];
};
const prefix = (actual, expected) => actual.length >= expected.length && expected.every((part, index) => actual[index] === part || actual[index] === undefined);

export const ownersRule = {
  meta: {
    type: "problem", schema: eslintRuleSchema("plumb/owners"),
    messages: { owner: "{{message}}", unresolved: "Cannot establish ownership through a computed or reassigned governed reference. {{message}}" },
  },
  create(context) {
    const { root = context.cwd, rows = [] } = context.options[0] ?? {};
    const file = rulesRelativeTo(root, context.filename), live = rows.filter((row) => !globMatches(row.owner, file));
    if (!live.length) return {};
    const effects = effectOrigins(context), reported = new WeakMap();
    const report = (node, row, incomplete = false) => {
      if (!reported.has(node)) reported.set(node, new Set());
      if (reported.get(node).has(row)) return;
      reported.get(node).add(row);
      context.report({ node, messageId: incomplete ? "unresolved" : "owner", data: { message: row.message } });
    };
    const match = (row, origin, construction = false) => {
      if (origin.container?.length || origin.caught) return false;
      if (origin.unknownModule) return row.importFrom ? "unresolved" : false;
      const actual = host(origin), requested = row.member && actual[0] && row.member.startsWith(`${actual[0]}.`) ? [actual[0], ...row.member.slice(actual[0].length + 1).split(".")] : row.member?.split(".");
      let found = requested && !origin.meta && prefix(actual, requested);
      if (row.global && origin.global) found ||= prefix(actual, [row.global]);
      if (row.now && !origin.meta) found ||= prefix(actual, ["Date", "now"]) || construction && actual.length === 1 && ["Date", undefined].includes(actual[0]);
      if (construction && row.construct && origin.global) found ||= actual.length === 1 && (row.construct.includes(actual[0]) || actual[0] === undefined);
      if (row.meta && origin.meta) found ||= origin.path[0] === row.meta || origin.path[0] === undefined && origin.path.length > 0;
      if (row.importFrom && origin.module && importsFrom(row, origin.module)) found ||= row.name === "*" || !origin.path.length || origin.path[0] === row.name || origin.path[0] === undefined;
      return found ? origin.uncertain || actual.some((part) => part === undefined) ? "unresolved" : true : false;
    };
    const inspect = (node, { construction = false, clock = false } = {}) => {
      const origins = effects.origins(node);
      for (const row of live) {
        const matches = origins.map((origin) => match(clock || !row.now ? row : { ...row, now: false }, origin, construction));
        let result = matches.includes(true) ? true : matches.includes("unresolved") ? "unresolved" : false;
        if (!result && row.importFrom && context.settings?.plumbTyped?.matches?.(context, node, { from: row.importFrom, name: row.name }) === true) result = true;
        if (result) report(node, row, result === "unresolved");
      }
    };
    const bindings = (pattern) => {
      if (!pattern) return [];
      if (pattern.type === "Identifier") return [pattern];
      if (pattern.type === "RestElement") return bindings(pattern.argument);
      if (pattern.type === "AssignmentPattern") return bindings(pattern.left);
      return (pattern.properties ?? pattern.elements ?? []).flatMap((item) => bindings(item?.value ?? item));
    };
    return {
      Identifier(node) { if (isValueReference(node)) inspect(node, { clock: true }); },
      MemberExpression(node) { inspect(node, { clock: true }); },
      VariableDeclarator(node) { if (node.id.type !== "Identifier") for (const name of bindings(node.id)) inspect(name, { clock: true }); },
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        if (!node.specifiers.length) for (const row of live) if (row.importFrom && row.name === "*" && importsFrom(row, node.source.value)) report(node, row);
        for (const imported of node.specifiers) if (imported.importKind !== "type") inspect(imported.local, { clock: true });
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === "type") return;
        for (const specifier of node.specifiers ?? []) {
          if (specifier.exportKind === "type") continue;
          if (specifier.local) inspect(specifier.local, { clock: true });
          if (!node.source) continue;
          for (const row of live) if (row.importFrom && importsFrom(row, node.source.value) && (row.name === "*" || specifier.type === "ExportNamespaceSpecifier" || (specifier.local?.name ?? specifier.local?.value) === row.name)) report(specifier, row);
        }
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === "type") return;
        for (const row of live) if (row.importFrom && importsFrom(row, node.source.value)) report(node, row);
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require" && !variableOf(context, node.callee)?.defs?.length) inspect(node, { clock: true });
      },
      ImportExpression(node) {
        const source = effects.literal(node.source);
        for (const row of live) {
          if (row.dynamicImport || row.importFrom && source !== undefined && importsFrom(row, source)) report(node, row);
          else if (row.importFrom && source === undefined) report(node, row, true);
        }
      },
      NewExpression(node) { inspect(node.callee, { construction: true, clock: node.arguments.length === 0 }); },
      JSXAttribute(node) {
        for (const row of live) if (row.jsxAttribute === node.name.name && (row.value === undefined || node.value?.type === "Literal" && node.value.value === row.value)) report(node, row);
      },
    };
  },
};
