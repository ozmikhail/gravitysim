import ts from "typescript";

import { AnalysisError, isTest, walk } from "./analysis.mjs";

const callable = (node) =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);

const ownerOf = (node) => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return parent;
  }
  return undefined;
};

const nameOf = (node) => {
  if (!callable(node)) return undefined;
  const name = ts.isVariableDeclaration(node.parent) ? node.parent.name : ts.isFunctionDeclaration(node) ? node.name : undefined;
  return name && ts.isIdentifier(name) ? name : undefined;
};

const synchronous = (node) =>
  callable(node) && !("asteriskToken" in node && node.asteriskToken) &&
  !ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);

const topLevel = (node) =>
  ts.isSourceFile(node.parent) ||
  (ts.isVariableDeclaration(node.parent) && ts.isSourceFile(node.parent.parent.parent.parent));

// A lexical direct call is checkable; whether the caller itself executes is a runtime property.
const direct = (node, owner) => {
  let expression = node;
  while (ts.isParenthesizedExpression(expression.parent) || ts.isAsExpression(expression.parent)) expression = expression.parent;
  if (ts.isArrowFunction(owner) && owner.body === expression) return true;
  return ts.isExpressionStatement(expression.parent) && expression.parent.parent === owner.body;
};

export const registrations = (analysis, contract) => {
  const rule = "contracts.registrations";
  const diagnostics = [];
  const selected = analysis.files.filter((file) => analysis.scope(contract.sources, file) && /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file) && !isTest(file));
  if (!selected.length) throw new AnalysisError("plumb.json", `No source modules are selected by ${contract.sources}.`);
  const files = [...new Set([...selected, analysis.relative(contract.composition.file)])].sort();
  for (const file of files) analysis.source(file);
  analysis.source(contract.call.from);
  analysis.source(contract.composition.file);
  const program = analysis.program(contract.composition.file);
  const checker = program.getTypeChecker();
  const symbolOf = (node) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const declarer = program.getSourceFile(analysis.absolute(contract.call.from));
  const composition = program.getSourceFile(analysis.absolute(contract.composition.file));
  if (!declarer || !composition) throw new AnalysisError(contract.composition.file, "The compiler could not load a configured registration module.");
  const targetSymbols = new Set();
  walk(declarer, (node) => {
    if (ts.isIdentifier(node) && node.text === contract.call.name) {
      const symbol = symbolOf(node);
      if (symbol?.declarations?.some((declaration) => declaration.getSourceFile() === declarer)) targetSymbols.add(symbol);
    }
  });
  if (!targetSymbols.size) throw new AnalysisError(contract.call.from, `The configured registration function ${contract.call.name} is not declared here.`);
  const report = (file, message, node) => {
    diagnostics.push(analysis.issue(rule, file, message, "Use named synchronous non-generator registrars and one direct call to each in the named composition function.", node));
  };
  let compositionOwner;
  walk(composition, (node) => {
    if (synchronous(node) && node.body && topLevel(node) && nameOf(node)?.text === contract.composition.function) compositionOwner = node;
  });
  if (!compositionOwner) report(contract.composition.file, `${contract.composition.function} must be a top-level synchronous non-generator function.`);
  const registrarSymbols = new Map();
  const calls = [];
  for (const file of files) {
    const source = program.getSourceFile(analysis.absolute(file));
    if (!source) throw new AnalysisError(file, "The compiler omitted a selected registration module.");
    walk(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      const symbol = symbolOf(node.expression);
      if (!symbol) return;
      calls.push({ node, symbol, file });
      if (!targetSymbols.has(symbol)) return;
      const owner = ownerOf(node);
      const name = owner && nameOf(owner);
      const registrar = name && symbolOf(name);
      if (!owner || !synchronous(owner) || !name?.text.endsWith(contract.registrar.suffix) || !registrar || !analysis.matches(contract.registrar.files, file) || owner === compositionOwner) {
        report(file, `Call ${contract.call.name} inside a synchronous non-generator function named …${contract.registrar.suffix}, in ${contract.registrar.files}.`, node);
      } else registrarSymbols.set(registrar, { name: name.text, file });
    });
  }
  const counts = new Map();
  for (const { node, symbol, file } of calls) {
    const registrar = registrarSymbols.get(symbol);
    if (!registrar) continue;
    if (compositionOwner && ownerOf(node) === compositionOwner && direct(node, compositionOwner)) {
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    } else report(file, `${registrar.name} may be called only directly in ${contract.composition.function}; nested, conditional and outside calls are refused.`, node);
  }
  for (const [symbol, registrar] of registrarSymbols) {
    if (counts.get(symbol) !== 1) report(registrar.file, `Call ${registrar.name} exactly once directly in ${contract.composition.function}.`);
  }
  if (!registrarSymbols.size) report(contract.sources, `No valid registrar calls ${contract.call.name}.`);
  return diagnostics;
};
