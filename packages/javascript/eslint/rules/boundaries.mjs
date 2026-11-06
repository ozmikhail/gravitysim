import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import { ownersRule } from "../owners.mjs";
import { createModuleResolver } from "../../shared/module-resolver.mjs";
import { eslintRuleSchema } from "../options.mjs";
import { rulesReasoned as reasoned, rulesRelativeTo as relativeTo } from "./shared.mjs";

const layersRule = {
  meta: {
    type: "problem",
    schema: eslintRuleSchema("plumb/layers"),
    messages: {
      up: "{{from}} (layer {{fromLayer}}) may not import {{to}} (layer {{toLayer}}): imports point down",
      across:
        "{{from}} may not import another area's files ({{to}}): keep it within its public area",
      lazy: "{{from}} may not load {{to}} lazily from below it: a dynamic import points down too",
      package: "{{tree}}/ may not import {{source}}: {{reason}}",
      unresolved: "Cannot verify the layer boundary: {{source}} does not resolve from {{from}}",
    },
  },
  create(context) {
    const { root = context.cwd, layers = [], packages = [] } = context.options[0] ?? {};
    const resolver = context.settings?.plumbResolver ?? createModuleResolver(root);
    reasoned(packages, "layers packages");
    const table = layers.map(([pattern, layer, name]) => [new RegExp(pattern), layer, name]);
    const layerOf = (relative) => {
      for (const [pattern, layer, name] of table) {
        const match = pattern.exec(relative);
        if (match) {
          return { layer, name, area: match[1] ? `${name}/${match[1]}` : null };
        }
      }
      return null;
    };
    const fromRelative = relativeTo(root, context.filename);
    const from = layerOf(fromRelative);
    if (!from) {
      return {};
    }
    const check = (node, source, { isType, isDynamic }) => {
      if (isType) {
        return; // a type may point anywhere
      }
      const fenced = packages.find(
        (entry) =>
          entry.tree === from.name &&
          (source === entry.source || source.startsWith(`${entry.source}/`)),
      );
      if (fenced) {
        context.report({ node, messageId: "package", data: fenced });
        return;
      }
      const resolved = resolver.runtime(context.filename, source);
      if (!resolved) {
        // an existing stylesheet or media file is an asset, not a module edge between layers
        const asset = !/\.[cm]?[jt]sx?$/.test(source) && /\.[a-z0-9]+(?:\?.*)?$/i.test(source) && existsSync(resolvePath(dirname(context.filename), source.replace(/\?.*$/, "")));
        if (!asset && resolver.isLocal(context.filename, source)) {
          context.report({ node, messageId: "unresolved", data: { source, from: fromRelative } });
        }
        return;
      }
      const target = relativeTo(root, resolved);
      const to = layerOf(target);
      if (!to) {
        return;
      }
      if (isDynamic && to.layer > from.layer) {
        context.report({ node, messageId: "lazy", data: { from: fromRelative, to: target } });
        return;
      }
      if (to.layer > from.layer) {
        context.report({
          node,
          messageId: "up",
          data: { from: fromRelative, fromLayer: from.layer, to: target, toLayer: to.layer },
        });
        return;
      }
      if (from.area && to.area && from.area !== to.area) {
        context.report({ node, messageId: "across", data: { from: fromRelative, to: target } });
      }
    };
    return {
      ImportDeclaration(node) {
        // inline type specifiers keep an empty runtime import under verbatimModuleSyntax
        check(node, node.source.value, { isType: node.importKind === "type", isDynamic: false });
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          check(node, node.source.value, { isType: node.exportKind === "type", isDynamic: false });
        }
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value, { isType: node.exportKind === "type", isDynamic: false });
      },
      ImportExpression(node) {
        if (node.source.type === "Literal" && typeof node.source.value === "string") {
          check(node, node.source.value, { isType: false, isDynamic: true });
        }
      },
    };
  },
}; // every edge is an error: imports point down, and no area reaches into another

export const plumbBoundaryRules = {
  layers: layersRule,
  owners: ownersRule,
};
