import { eslintRuleSchema } from "../options.mjs";

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

const PAINT =
  "bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|fill|stroke|outline|decoration|shadow|from|via|to|divide|placeholder|caret|accent";

const RAW_COLOUR = new RegExp(
  `(?:^|[\\s:!])(?:${PAINT})-(?:(?:${PALETTE})-\\d{2,3}|white|black)(?:\\/\\d+)?(?=$|\\s)`,
); // a palette step or white and black, never a token like bg-cyan-subtle

const ARBITRARY_COLOUR = new RegExp(
  `(?:^|[\\s:!])(?:${PAINT})-\\[(?:#|rgba?\\(|hsla?\\(|oklch\\(|oklab\\(|lab\\(|lch\\(|color\\()`,
); // a colour written out in brackets, which slips past the palette check

const DARK_VARIANT = /(?:^|[\s:])dark:/;

const tokensRule = {
  meta: {
    type: "problem",
    schema: eslintRuleSchema("plumb-react/tokens"),
    messages: {
      raw: "Paint with a token, never a raw palette colour",
      dark: "A scheme is tokens under data-theme: never a dark: variant",
    },
  },
  create(context) {
    const allow = new Set(context.options[0]?.allow ?? []);
    const check = (node, text) => {
      const raw = text.split(/\s+/).some((word) => {
        const colour = word
          .replace(/\/\d+$/, "")
          .split("-")
          .at(-1);
        return (RAW_COLOUR.test(word) || ARBITRARY_COLOUR.test(word)) && !allow.has(colour);
      }); // a word painted raw, unless its colour is one the tree allows
      if (raw) {
        context.report({ node, messageId: "raw" });
      }
      if (DARK_VARIANT.test(text)) {
        context.report({ node, messageId: "dark" });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") {
          check(node, node.value);
        }
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

const PHYSICAL_CLASS =
  /(?:^|[\s:])(?:-?m[lr]|p[lr]|-?left|-?right|border-[lr]|rounded-[lr]|rounded-[tb][lr]|text-left|text-right|scroll-m[lr]|scroll-p[lr])(?:-|$|\s)/;

const isClassAttribute = (node) => {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "JSXAttribute") {
      return current.name.name === "className";
    }
    if (current.type === "CallExpression" && current.callee.name === "tv") {
      return true;
    }
  }
  return false;
}; // a string that lands in a class set: a className, or anything a tv recipe holds

const classSetRule = {
  meta: {
    type: "suggestion",
    schema: eslintRuleSchema("plumb-react/class-set"),
    messages: {
      physical:
        "Use logical direction (ms-, me-, ps-, pe-, start-, end-, text-start), never left and right; a class that must stay physical says why in a // physical: comment on its line",
      join: "Compose a class set with tv at module scope, never by joining strings",
      variants: "Name a tv recipe …Variants, as {{name}}Variants",
      inline: "Put a set of classes in a module-scope tv recipe, and pass its slot here",
    },
  },
  create(context) {
    const {
      physical = false,
      joins = false,
      variants = false,
      inline = false,
    } = context.options[0] ?? {};
    const checkInline = (node, text) => {
      const isClassName =
        node.parent.type === "JSXAttribute" ||
        (node.parent.type === "JSXExpressionContainer" &&
          node.parent.parent.type === "JSXAttribute");
      const attribute = node.parent.type === "JSXAttribute" ? node.parent : node.parent.parent;
      if (
        inline &&
        isClassName &&
        attribute.name.name === "className" &&
        text.trim().split(/\s+/).length > 1
      ) {
        context.report({ node, messageId: "inline" });
      }
    };
    const reasoned = new Set(
      context.sourceCode
        .getAllComments()
        .filter((comment) => /^\s*physical:\s*\S/.test(comment.value))
        .map((comment) => comment.loc.start.line),
    ); // the lines whose class is physical on purpose, with the reason beside it
    const checkPhysical = (node, text) => {
      if (
        physical &&
        isClassAttribute(node) &&
        PHYSICAL_CLASS.test(text) &&
        !reasoned.has(node.loc.end.line)
      ) {
        context.report({ node, messageId: "physical" });
      }
    };
    return {
      VariableDeclarator(node) {
        const isRecipe =
          node.init?.type === "CallExpression" &&
          node.init.callee.type === "Identifier" &&
          node.init.callee.name === "tv";
        const isModuleScope =
          node.parent.parent.type === "Program" ||
          node.parent.parent.type === "ExportNamedDeclaration";
        if (
          variants &&
          isRecipe &&
          isModuleScope &&
          node.id.type === "Identifier" &&
          !node.id.name.endsWith("Variants")
        ) {
          context.report({ node: node.id, messageId: "variants", data: { name: node.id.name } });
        }
      },
      CallExpression(node) {
        if (
          joins &&
          node.callee.type === "MemberExpression" &&
          node.callee.property.name === "join" &&
          isClassAttribute(node)
        ) {
          context.report({ node, messageId: "join" });
        }
      },
      Literal(node) {
        if (typeof node.value === "string") {
          checkPhysical(node, node.value);
          checkInline(node, node.value);
        }
      },
      TemplateElement(node) {
        checkPhysical(node, node.value.cooked ?? node.value.raw);
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0) {
          checkInline(node, node.quasis[0].value.cooked ?? "");
        }
      },
    };
  },
};

export const plumbClassRules = {
  "class-set": classSetRule,
  tokens: tokensRule,
};
