const moduleSection = (node) => {
  const declaration = node.declaration ?? node;
  if (["ExportNamedDeclaration", "ExportAllDeclaration"].includes(declaration.type)) {
    return "exports";
  }
  if (declaration.type === "ImportDeclaration") {
    return "imports";
  }
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations.some((entry) =>
      ["ArrowFunctionExpression", "FunctionExpression"].includes(entry.init?.type),
    )
      ? "function"
      : "variables";
  }
  return declaration.type;
};

const moduleSpacingRule = {
  meta: {
    type: "layout",
    fixable: "whitespace",
    schema: [],
    messages: {
      missing: "Separate module sections, class members, and functions with a blank line.",
      joined: "Keep consecutive bound singleton exports together.",
    },
  },
  create(context) {
    const source = context.sourceCode;
    const isBoundExport = (node) =>
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "VariableDeclaration" &&
      node.declaration.declarations.every(
        (entry) =>
          entry.init?.type === "CallExpression" &&
          entry.init.callee.type === "MemberExpression" &&
          !entry.init.callee.computed &&
          entry.init.callee.property.name === "bind",
      );
    const requireBlankLine = (previous, current) => {
      const comments = source.getTokensBetween(previous, current, { includeComments: true });
      const boundaries = [previous, ...comments, current];
      if (
        boundaries.some(
          (entry, offset) =>
            offset > 0 && entry.loc.start.line > boundaries[offset - 1].loc.end.line + 1,
        )
      ) {
        return;
      }
      const anchor =
        comments.find((entry) => entry.loc.start.line > previous.loc.end.line) ?? current;
      context.report({
        node: current,
        messageId: "missing",
        fix: (fixer) =>
          fixer.insertTextBefore(
            anchor,
            anchor.loc.start.line > previous.loc.end.line ? "\n" : "\n\n",
          ),
      });
    };

    return {
      Program(node) {
        for (let index = 1; index < node.body.length; index++) {
          const previous = node.body[index - 1];
          const current = node.body[index];
          if (isBoundExport(previous) && isBoundExport(current)) {
            const gap = source.text.slice(previous.range[1], current.range[0]);
            if (/^\s*\n\s*\n\s*$/.test(gap)) {
              context.report({
                node: current,
                messageId: "joined",
                fix: (fixer) => fixer.replaceTextRange([previous.range[1], current.range[0]], "\n"),
              });
            }
            continue;
          }
          const section = moduleSection(current);
          if (
            section === moduleSection(previous) &&
            ["imports", "exports", "variables"].includes(section)
          ) {
            continue;
          }
          requireBlankLine(previous, current);
        }
      },
      ClassBody(node) {
        for (let index = 1; index < node.body.length; index++) {
          const previous = node.body[index - 1];
          const current = node.body[index];
          if (
            previous.type === "MethodDefinition" &&
            current.type === "MethodDefinition" &&
            previous.static === current.static &&
            source.getText(previous.key) === source.getText(current.key) &&
            (previous.kind === current.kind ||
              (previous.kind === "get" && current.kind === "set") ||
              (previous.kind === "set" && current.kind === "get"))
          ) {
            continue;
          }
          const previousSection =
            previous.type === "PropertyDefinition" || previous.type === "AccessorProperty"
              ? "variables"
              : "function";
          const currentSection =
            current.type === "PropertyDefinition" || current.type === "AccessorProperty"
              ? "variables"
              : "function";
          if (previousSection === currentSection && currentSection === "variables") {
            continue;
          }
          requireBlankLine(previous, current);
        }
      },
    };
  },
};

const importsFirstRule = {
  meta: {
    type: "layout",
    schema: [],
    messages: { first: "Keep static imports before module declarations; move them manually while preserving dependency evaluation order." },
  },
  create(context) {
    return {
      Program(node) {
        let firstStatement;
        for (const statement of node.body) {
          if (statement.type === "ExpressionStatement" && statement.directive && !firstStatement) {
            continue;
          }
          if (statement.type !== "ImportDeclaration") {
            firstStatement ??= statement;
            continue;
          }
          if (!firstStatement) {
            continue;
          }
          context.report({
            node: statement,
            messageId: "first",
          });
        }
      },
    };
  },
};

const classStyleRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      function: "Library behavior belongs in a class; export a bound method from its singleton.",
      class: "A library module organizes its behavior in a class.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const declarations = node.body.map((entry) => entry.declaration ?? entry);
        if (!declarations.some((entry) => entry.type === "ClassDeclaration")) {
          context.report({ node, messageId: "class" });
        }
        for (const entry of declarations) {
          if (entry.type === "FunctionDeclaration") {
            context.report({ node: entry, messageId: "function" });
            continue;
          }
          if (entry.type !== "VariableDeclaration") {
            continue;
          }
          for (const declaration of entry.declarations) {
            const init = declaration.init;
            if (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression") {
              context.report({ node: declaration, messageId: "function" });
            }
          }
        }
      },
    };
  },
};

export const plumbLayoutRules = {
  "class-style": classStyleRule,
  "imports-first": importsFirstRule,
  "module-spacing": moduleSpacingRule,
};
