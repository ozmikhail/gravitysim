// Bounded lexical provenance complements compiler symbol identity. It never evaluates source.
export const unwrapExpression = (node) => node && ["ChainExpression", "TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(node.type) ? unwrapExpression(node.expression) : node;

export function variableOf(context, node) {
  if (node?.type !== "Identifier") return undefined;
  for (let scope = context.sourceCode?.getScope?.(node); scope; scope = scope.upper) {
    const variable = scope.set?.get(node.name);
    if (variable) return variable;
  }
  return undefined;
}

export function effectOrigins(context) {
  const modified = (variable) => (variable.references ?? []).some((reference) => reference.isWrite?.() && !reference.init);
  const constant = (node, seen = new Set()) => {
    node = unwrapExpression(node);
    if (!node || seen.size > 48) return undefined;
    if (node.type === "Literal" && ["string", "number"].includes(typeof node.value)) return node.value;
    if (node.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = constant(node.left, seen), right = constant(node.right, seen);
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
    if (node.type !== "Identifier") return undefined;
    const variable = variableOf(context, node);
    if (!variable || seen.has(variable) || modified(variable)) return undefined;
    const definition = variable.defs?.find((item) => item.type === "Variable" && item.node.id.type === "Identifier");
    return definition ? constant(definition.node.init, new Set([...seen, variable])) : undefined;
  };
  const literal = (node) => { const value = constant(node); return value === undefined ? undefined : String(value); };
  const property = (node) => !node.computed && node.key?.type === "Identifier" ? node.key.name : literal(node.key);
  const paths = (pattern, name, prefix = []) => {
    if (!pattern) return [];
    if (pattern.type === "Identifier") return pattern.name === name ? [prefix] : [];
    if (pattern.type === "AssignmentPattern") return paths(pattern.left, name, [...prefix, { uncertain: true }]);
    if (pattern.type === "RestElement") return paths(pattern.argument, name, [...prefix, { rest: true }]);
    if (pattern.type === "ObjectPattern") return pattern.properties.flatMap((item) => item.type === "RestElement" ? paths(item, name, prefix) : paths(item.value, name, [...prefix, property(item)]));
    if (pattern.type === "ArrayPattern") return pattern.elements.flatMap((item, index) => paths(item, name, [...prefix, String(index)]));
    return [];
  };
  const append = (origins, key) => origins.flatMap((origin) => {
    if (key?.uncertain || key?.rest) return [{ ...origin, uncertain: true }];
    if (origin.container?.length) {
      if (key !== undefined && key !== origin.container[0]) return [];
      return [{ ...origin, container: origin.container.slice(1), ...(key === undefined ? { uncertain: true } : {}) }];
    }
    return [{ ...origin, path: [...origin.path, key], ...(key === undefined ? { uncertain: true } : {}) }];
  });
  const origins = (node, seen = new Set()) => {
    node = unwrapExpression(node);
    if (!node || seen.size > 48) return [];
    if (node.type === "MetaProperty" && node.meta.name === "import" && node.property.name === "meta") return [{ meta: true, path: [] }];
    if (node.type === "MemberExpression") return append(origins(node.object, seen), !node.computed && node.property.type === "Identifier" ? node.property.name : literal(node.property));
    if (node.type === "AssignmentExpression") return origins(node.right, seen);
    if (node.type === "ConditionalExpression" || node.type === "LogicalExpression") return [...origins(node.consequent ?? node.left, seen), ...origins(node.alternate ?? node.right, seen)].map((row) => ({ ...row, uncertain: true }));
    if (node.type === "SequenceExpression") return origins(node.expressions.at(-1), seen);
    if (node.type === "ObjectExpression") return node.properties.flatMap((item) => {
      if (item.type === "SpreadElement") return origins(item.argument, seen).map((row) => ({ ...row, uncertain: true }));
      return origins(item.value, seen).map((row) => ({ ...row, container: [property(item), ...row.container ?? []] }));
    });
    if (node.type === "ArrayExpression") return node.elements.flatMap((item, index) => origins(item, seen).map((row) => ({ ...row, container: [String(index), ...row.container ?? []] })));
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require" && !variableOf(context, node.callee)?.defs?.length) {
      const module = literal(node.arguments[0]);
      return [{ ...(module === undefined ? { unknownModule: true } : { module }), path: [] }];
    }
    if (node.type !== "Identifier") return [];
    const variable = variableOf(context, node);
    if (!variable?.defs?.length) return [{ global: node.name, path: [] }];
    if (seen.has(variable)) return [];
    const next = new Set([...seen, variable]), result = [];
    for (const definition of variable.defs) {
      if (definition.type === "ImportBinding") {
        const imported = definition.node, declaration = definition.parent ?? imported.parent;
        const module = declaration?.source?.value;
        if (!module || declaration.importKind === "type" || imported.importKind === "type") continue;
        result.push({ module, path: imported.type === "ImportNamespaceSpecifier" ? [] : [imported.type === "ImportDefaultSpecifier" ? "default" : imported.imported.name ?? imported.imported.value] });
      }
      if (definition.type === "Variable") {
        for (const path of paths(definition.node.id, node.name)) {
          let values = origins(definition.node.init, next);
          for (const key of path) values = append(values, key);
          result.push(...values);
        }
      }
      if (definition.type === "CatchClause") result.push({ caught: true, path: [] });
    }
    if (modified(variable)) {
      for (const reference of variable.references ?? []) {
        const assignment = reference.identifier?.parent;
        if (reference.isWrite?.() && !reference.init && assignment?.type === "AssignmentExpression") result.push(...origins(assignment.right, next));
      }
      return result.map((row) => ({ ...row, uncertain: true }));
    }
    return result;
  };
  const initialization = (node, seen = new Set()) => {
    node = unwrapExpression(node);
    if (node?.type !== "Identifier") return node;
    const variable = variableOf(context, node);
    if (!variable || seen.has(variable) || modified(variable)) return node;
    const definition = variable.defs?.find((item) => item.type === "Variable" && item.node.id.type === "Identifier");
    return definition?.node.init ? initialization(definition.node.init, new Set([...seen, variable])) : node;
  };
  return { origins, append, literal, property, initialization };
}

export function isValueReference(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier", "ExportSpecifier"].includes(parent.type)) return false;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  if (["Property", "MethodDefinition", "PropertyDefinition"].includes(parent.type) && parent.key === node && !parent.computed && !parent.shorthand) return false;
  if (["VariableDeclarator", "FunctionDeclaration", "FunctionExpression", "ClassDeclaration", "ClassExpression"].includes(parent.type) && parent.id === node) return false;
  if (["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent.type)) return false;
  for (let cursor = parent; cursor; cursor = cursor.parent) {
    if (["TSTypeAnnotation", "TSTypeReference", "TSTypeQuery", "TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSImportType", "TSTypeParameter"].includes(cursor.type)) return false;
    if (["Statement", "Expression"].some((suffix) => cursor.type.endsWith(suffix)) || cursor.type === "Program") break;
  }
  return true;
}
