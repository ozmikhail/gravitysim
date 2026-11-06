const isClientDirective = (statement) =>
  statement?.type === "ExpressionStatement" && statement.directive === "use client";

const clientDirectiveRule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      missing: 'This configured client module renders or calls a hook; declare "use client" in its directive prologue after reviewing the boundary',
    },
  },
  create(context) {
    let usesReact = false;
    return {
      JSXElement() {
        usesReact = true;
      },
      JSXFragment() {
        usesReact = true;
      },
      ImportDeclaration(node) {
        if (!["react", "react-dom"].includes(node.source.value) || node.importKind === "type") {
          return;
        }
        if (
          node.specifiers.some(
            (specifier) => specifier.type !== "ImportSpecifier" || specifier.importKind !== "type",
          )
        ) {
          usesReact = true;
        }
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && /^use[A-Z]/.test(node.callee.name)) {
          usesReact = true;
        }
      },
      "Program:exit"(program) {
        const firstCode = program.body.findIndex((statement) => statement.type !== "ExpressionStatement" || !statement.directive);
        const directives = firstCode === -1 ? program.body : program.body.slice(0, firstCode);
        const marked = directives.some(isClientDirective);
        if (usesReact && !marked) {
          context.report({
            node: program,
            messageId: "missing",
          });
        }
      },
    };
  },
}; // the client boundary is marked where it is, so a server render could find it

const isComponentName = (name) => /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(name); // PascalCase, never UPPER_SNAKE

const isComponentValue = (node) => {
  if (!node) {
    return false;
  }
  if (["ArrowFunctionExpression", "FunctionExpression", "ClassExpression"].includes(node.type)) {
    return true;
  }
  if (node.type === "CallExpression") {
    const callee = node.callee.type === "MemberExpression" ? node.callee.property : node.callee;
    return ["memo", "forwardRef", "lazy", "assign"].includes(callee?.name); // Object.assign builds a namespace
  }
  if (node.type === "ObjectExpression") {
    return (
      node.properties.length > 0 &&
      node.properties.every(
        (entry) =>
          entry.type === "Property" &&
          !entry.computed &&
          entry.value.type === "Identifier" &&
          isComponentName(entry.value.name),
      )
    ); // a namespace of components: Calendar.Grid, Calendar.Cell
  }
  return false;
};

const refreshBoundaryRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      mixed:
        "A module that exports a component exports only components and types: move {{name}} to a .ts module beside it",
    },
  },
  create(context) {
    if (!context.filename.endsWith(".tsx")) {
      return {};
    }
    const components = [];
    const others = [];
    const take = (name, value, node) => {
      (isComponentName(name) && isComponentValue(value) ? components : others).push({ name, node });
    };
    return {
      ExportNamedDeclaration(node) {
        if (node.exportKind === "type") {
          return;
        }
        const declaration = node.declaration;
        if (!declaration) {
          for (const specifier of node.specifiers) {
            if (specifier.exportKind !== "type") {
              const name = specifier.exported.name;
              (isComponentName(name) ? components : others).push({ name, node: specifier });
            }
          }
          return;
        }
        if (
          declaration.type === "TSInterfaceDeclaration" ||
          declaration.type === "TSTypeAliasDeclaration"
        ) {
          return;
        }
        if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
          take(declaration.id.name, { type: "FunctionExpression" }, declaration);
          return;
        }
        if (declaration.type === "VariableDeclaration") {
          for (const declarator of declaration.declarations) {
            if (declarator.id.type === "Identifier") {
              take(declarator.id.name, declarator.init, declarator);
            } else {
              others.push({ name: "a destructured export", node: declarator });
            }
          }
          return;
        }
        others.push({ name: "an export", node: declaration });
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== "type") others.push({ name: "a wildcard re-export", node });
      },
      ExportDefaultDeclaration(node) {
        const declaration = node.declaration;
        const name =
          declaration.id?.name ?? (declaration.type === "Identifier" ? declaration.name : "");
        (isComponentName(name) ? components : others).push({ name: name || "default", node });
      },
      "Program:exit"() {
        if (components.length === 0) {
          return;
        }
        for (const other of others) {
          context.report({ node: other.node, messageId: "mixed", data: { name: other.name } });
        }
      },
    };
  },
};

const LINE_MAX = 80; // a reader's line, counted in characters as written
const JOINER = /[;–—]/u; // a semicolon, an en dash or an em dash

const linesRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      long: "{{key}} runs {{length}} characters, past the {{max}} a line may take",
      joined:
        "{{key}} joins clauses with a semicolon or a dash: say one thing, or make it two lines",
    },
  },
  create(context) {
    return {
      Property(node) {
        if (node.value.type !== "Literal" || typeof node.value.value !== "string") {
          return;
        }
        const key = node.key.value ?? node.key.name;
        const text = node.value.value;
        const length = [...text].length; // characters, so vóór counts four
        if (length > LINE_MAX) {
          context.report({
            node: node.value,
            messageId: "long",
            data: { key, length, max: LINE_MAX },
          });
        }
        if (JOINER.test(text)) {
          context.report({ node: node.value, messageId: "joined", data: { key } });
        }
      },
    };
  },
};

const propsRule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: {
      named: "Give {{name}}'s props a named interface, {{name}}Props, beside it",
    },
  },
  create(context) {
    const check = (name, fn) => {
      const props = fn?.params[0];
      const annotation = props?.typeAnnotation?.typeAnnotation;
      if (isComponentName(name) && annotation?.type === "TSTypeLiteral") {
        context.report({ node: annotation, messageId: "named", data: { name } });
      }
    };
    return {
      FunctionDeclaration(node) {
        if (node.id) {
          check(node.id.name, node);
        }
      },
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier" &&
          ["ArrowFunctionExpression", "FunctionExpression"].includes(node.init?.type)
        ) {
          check(node.id.name, node.init);
        }
      },
    };
  },
}; // a component's props read as a name in its signature and in the editor

const WORDED_ATTRIBUTES = new Set(["alt", "aria-label", "label", "placeholder", "title"]);

const LETTERS = /\p{L}{2}/u; // a word, not a mark or a figure

const COPY_KEY = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/; // a catalogue key, which a part looks up

const literalText = (node) => node?.type === "Literal" ? node.value
  : node?.type === "TemplateLiteral" && node.expressions.length === 0
    ? node.quasis.map((entry) => entry.value.cooked ?? entry.value.raw).join("")
    : undefined;

const wordsRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      words: "Words a reader sees come from the project's catalogue, never written in place",
    },
  },
  create(context) {
    return {
      JSXText(node) {
        if (LETTERS.test(node.value)) {
          context.report({ node, messageId: "words" });
        }
      },
      JSXExpressionContainer(node) {
        if (node.parent.type === "JSXAttribute") return;
        const text = literalText(node.expression);
        if (typeof text === "string" && LETTERS.test(text)) context.report({ node, messageId: "words" });
      },
      JSXAttribute(node) {
        const value = node.value;
        const text = literalText(value?.type === "JSXExpressionContainer" ? value.expression : value);
        if (
          WORDED_ATTRIBUTES.has(node.name.name) &&
          typeof text === "string" &&
          LETTERS.test(text) &&
          !COPY_KEY.test(text)
        ) {
          context.report({ node, messageId: "words" });
        }
      },
    };
  },
}; // the words live in one catalogue, where their rules and their reader's language are kept

export const plumbComponentRules = {
  "client-directive": clientDirectiveRule,
  lines: linesRule,
  props: propsRule,
  "refresh-boundary": refreshBoundaryRule,
  words: wordsRule,
};
