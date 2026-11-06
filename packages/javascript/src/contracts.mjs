import { basename, dirname, resolve } from "node:path";

import ts from "typescript";

import { AnalysisError, edges, isScript, literal, walk } from "./analysis.mjs";

const unwrap = (node) =>
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    ? unwrap(node.expression) : node;

export const manifest = (analysis, contract) => {
  const rule = "contracts.manifests";
  const source = analysis.source(contract.file);
  const directory = dirname(source.fileName);
  const diagnostics = [];
  const report = (message, node) => {
    diagnostics.push(analysis.issue(rule, contract.file, message, "Make the literal catalogue cover the entry and each direct local runtime dependency exactly once.", node));
  };
  const declaration = source.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((item) => ts.isIdentifier(item.name) && item.name.text === contract.variable);
  const initializer = declaration?.initializer && unwrap(declaration.initializer);
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
    report(`${contract.variable} must be an explicit literal array of paths.`, declaration);
    return diagnostics;
  }
  const listed = new Set();
  for (const item of initializer.elements) {
    if (!literal(item)) { report(`Every ${contract.variable} entry must be a string literal.`, item); continue; }
    const target = analysis.relative(resolve(directory, item.text));
    if (listed.has(target)) report(`${item.text} is listed twice.`, item);
    listed.add(target);
    if (!analysis.inventory.has(target)) report(`${item.text} is absent from the checked inventory.`, item);
  }
  const entry = analysis.relative(resolve(directory, contract.entry));
  if (!listed.has(entry)) report(`The entry ${contract.entry} is missing from ${contract.variable}.`);
  const exemptions = new Set((contract.exempt ?? []).map((item) => analysis.relative(item.path)));
  const used = new Set();
  for (const edge of edges(analysis.source(entry)).filter((item) => !item.typeOnly)) {
    if (!edge.specifier) { report("A runtime dependency must name a literal path so the catalogue can cover it."); continue; }
    const target = analysis.target(entry, edge.specifier, undefined, true);
    if (!target) continue;
    if (exemptions.has(target)) used.add(target);
    else if (!listed.has(target)) report(`The direct dependency ${target} is missing from ${contract.variable}.`);
  }
  for (const exemption of exemptions) {
    if (!used.has(exemption)) report(`The exemption for ${exemption} is unused; remove it.`);
  }
  return diagnostics;
};

export const lazyModules = (analysis, contract) => {
  const rule = "contracts.lazy-modules";
  const diagnostics = [];
  const report = (file, message, node) => {
    diagnostics.push(analysis.issue(rule, file, message, "Keep literal lazy imports, the page catalogue and matching file names in agreement.", node));
  };
  const loaded = new Set();
  for (const edge of edges(analysis.source(contract.loader))) {
    if (!ts.isCallExpression(edge.node) || edge.node.expression.kind !== ts.SyntaxKind.ImportKeyword) continue;
    if (!edge.specifier) { report(contract.loader, "A lazy-module import must name a literal path.", edge.node); continue; }
    const target = analysis.target(contract.loader, edge.specifier, undefined, true);
    if (target && isScript(target)) loaded.add(target);
    else report(contract.loader, `The lazy import ${edge.specifier} must resolve to a checked local script.`, edge.node);
  }
  if (contract.listing) {
    const { file, pattern, root } = contract.listing;
    const expression = new RegExp(pattern);
    const listed = new Set();
    walk(analysis.source(file), (node) => {
      if (literal(node) && expression.test(node.text)) listed.add(analysis.relative(resolve(analysis.root, root, node.text)));
    });
    for (const target of loaded) if (!listed.has(target)) report(contract.loader, `${target} is loaded but never named by ${file}.`);
    for (const target of listed) if (!loaded.has(target)) report(file, `${target} is named but never loaded by ${contract.loader}.`);
  }
  const naming = new RegExp(contract.names.pattern);
  const candidates = analysis.required(contract.names.files);
  for (const file of candidates) {
    const named = naming.test(basename(file));
    if (named && !loaded.has(file)) report(file, `This file takes a lazy-module name but ${contract.loader} never loads it.`);
    if (!named && loaded.has(file)) report(file, `A lazy module must match ${contract.names.pattern}.`);
  }
  for (const file of loaded) {
    if (!candidates.includes(file)) report(file, `This lazy module falls outside the naming scope ${contract.names.files}.`);
  }
  return diagnostics;
};

const typePosition = (node) => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  }
  return false;
};

export const writtenOnce = (analysis, contract) => {
  const pattern = new RegExp(contract.values);
  const values = new Set();
  walk(analysis.source(contract.table), (node) => {
    if (!ts.isPropertyAssignment(node)) return;
    const value = unwrap(node.initializer);
    if (literal(value) && pattern.test(value.text)) values.add(value.text);
  });
  if (!values.size) throw new AnalysisError(contract.table, "The value-ownership pattern matches no literal table values.");
  const diagnostics = [];
  for (const file of analysis.required(contract.files)) {
    if (file === analysis.relative(contract.table) || analysis.matches(contract.ignore ?? [], file)) continue;
    walk(analysis.source(file), (node) => {
      if (literal(node) && values.has(node.text) && !typePosition(node)) {
        diagnostics.push(analysis.issue("contracts.written-once", file, `${JSON.stringify(node.text)} is owned by ${contract.table}.`, "Import the named table value instead of repeating its literal.", node));
      }
    });
  }
  return diagnostics;
};

// This contract follows static runtime edges. It does not prove dynamic reachability.
export const importGraph = (analysis, contract) => {
  const diagnostics = [];
  const packages = contract.refuse.packages ? new RegExp(contract.refuse.packages) : undefined;
  const specifiers = contract.refuse.specifiers ? new RegExp(contract.refuse.specifiers) : undefined;
  if (!analysis.files.some((file) => analysis.scope(contract.within, file))) {
    throw new AnalysisError("plumb.json", `The graph scope ${contract.within} contains no checked files.`);
  }
  const seen = new Set();
  const visit = (file, entry) => {
    if (seen.has(file)) return;
    seen.add(file);
    const inside = analysis.scope(contract.within, file);
    if (inside && contract.refuse.extensions?.some((extension) => file.endsWith(extension))) {
      diagnostics.push(analysis.issue("contracts.import-graphs", file, `${entry} reaches a refused file kind: ${file}. ${contract.reason}`, "Keep this static runtime graph within its allowed file kinds."));
      return;
    }
    if (!isScript(file)) return;
    for (const edge of edges(analysis.source(file)).filter((item) => !item.dynamic && !item.typeOnly)) {
      if (!edge.specifier) throw new AnalysisError(file, "A static dependency could not be resolved from a literal specifier.");
      if (inside && (packages?.test(edge.specifier) || specifiers?.test(edge.specifier))) {
        diagnostics.push(analysis.issue("contracts.import-graphs", file, `${entry} reaches an import of ${edge.specifier}. ${contract.reason}`, "Remove the refused dependency from this static runtime graph.", edge.node));
      } else {
        const target = analysis.target(file, edge.specifier, undefined, true);
        if (target) visit(target, entry);
      }
    }
  };
  for (const file of analysis.required(contract.entries)) visit(file, file);
  return diagnostics;
};

export const boundaries = (analysis, contract) => {
  const diagnostics = [];
  for (const file of analysis.required(contract.from)) {
    for (const edge of edges(analysis.source(file))) {
      if (!edge.specifier) {
        diagnostics.push(analysis.issue("contracts.boundaries", file, "A computed dependency cannot prove the configured module boundary.", "Use a literal import or an approved narrow exception.", edge.node));
        continue;
      }
      const bare = !edge.specifier.startsWith(".") && !edge.specifier.startsWith("/");
      const named = bare && analysis.matches(contract.deny, edge.specifier);
      const target = named ? undefined : analysis.target(file, edge.specifier, undefined, !edge.typeOnly);
      if (named || (target && analysis.matches(contract.deny, target))) {
        diagnostics.push(analysis.issue("contracts.boundaries", file, `Importing ${target ?? edge.specifier} violates this boundary. ${contract.reason}`, "Move the dependency behind an allowed interface or into its owning layer.", edge.node));
      }
    }
  }
  return diagnostics;
};
