import { relative, resolve } from "node:path";
import ts from "typescript";
import { AnalysisError } from "../src/analysis.mjs";
import { strictCompilerOptions } from "./typed-policy.mjs";

export { strictCompilerOptions } from "./typed-policy.mjs";
const script = (file) => /\.[cm]?[jt]sx?$/.test(file);
const typed = (file) => /\.[cm]?tsx?$/.test(file);
const unwrap = (node) => node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) ? unwrap(node.expression) : node;
const unalias = (checker, symbol) => {
  const seen = new Set();
  while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) { seen.add(symbol); symbol = checker.getAliasedSymbol(symbol); }
  return symbol;
};
const uncertain = (type) => !type || !!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
const thenable = (checker, type, node) => {
  if (uncertain(type)) return undefined;
  if (type.isUnion()) { const values = type.types.map((part) => thenable(checker, part, node)); return values.includes(undefined) ? undefined : values.some(Boolean); }
  const property = checker.getPropertyOfType(type, "then");
  return !!property && checker.getTypeOfSymbolAtLocation(property, node).getCallSignatures().length > 0;
};

function typedServices(analysis, programs) {
  const declarations = new WeakMap();
  const service = (context, node) => {
    const parser = context.sourceCode.parserServices, program = parser?.program;
    if (!program || !programs.includes(program) || !parser.esTreeNodeToTSNodeMap) return undefined;
    const source = program.getSourceFile(context.filename), actual = node ? parser.esTreeNodeToTSNodeMap.get(node) : source;
    return source && actual ? { program, checker: program.getTypeChecker(), node: actual, source } : undefined;
  };
  const declared = ({ program, checker, source }, reference) => {
    if (!declarations.has(program)) declarations.set(program, new Map());
    const cache = declarations.get(program), key = JSON.stringify([source.fileName, reference]);
    if (cache.has(key)) return cache.get(key);
    const path = analysis.resolver.resolve(source.fileName, reference.from, program.getCompilerOptions());
    const module = path && program.getSourceFile(path);
    const symbol = module ? checker.getSymbolAtLocation(module) : checker.getAmbientModules().find((item) => item.name === JSON.stringify(reference.from));
    const exports = symbol ? checker.getExportsOfModule(symbol) : [];
    // a wildcard owns what the package declares, not foreign symbols it re-exports (bullmq re-exports node:crypto)
    const home = path && (/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+\/)/.exec(path)?.[1] ?? `${path.slice(0, path.lastIndexOf("/"))}/`);
    const owned = (item) => !home || item?.declarations?.some((node) => node.getSourceFile().fileName.startsWith(home));
    const selected = symbol ? reference.name === "*" ? exports.map((item) => unalias(checker, item)).filter(owned) : unalias(checker, exports.find((item) => item.name === reference.name)) : undefined;
    cache.set(key, selected); return selected;
  };
  const symbols = (checker, node, seen = new Set()) => {
    node = unwrap(node);
    if (!node) return [];
    let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : ts.isElementAccessExpression(node) ? node.argumentExpression : node);
    symbol = unalias(checker, symbol);
    if (!symbol || seen.has(symbol)) return [];
    const next = new Set([...seen, symbol]), result = [symbol];
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && declaration.parent.flags & ts.NodeFlags.Const) result.push(...symbols(checker, declaration.initializer, next));
      if (ts.isBindingElement(declaration)) {
        const variable = declaration.parent.parent;
        if (ts.isVariableDeclaration(variable) && variable.initializer && variable.parent.flags & ts.NodeFlags.Const) {
          const key = declaration.propertyName ?? declaration.name;
          if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
            const owner = checker.getTypeAtLocation(variable.initializer), member = checker.getPropertyOfType(owner, key.text);
            if (member) result.push(unalias(checker, member));
          }
        }
      }
    }
    return result;
  };
  return {
    matches(context, node, reference) {
      const state = service(context, node); if (!state) return undefined;
      const expected = declared(state, reference); if (!expected || !Array.isArray(expected) && !expected.declarations?.length) return undefined;
      const allowed = Array.isArray(expected) ? expected : [expected];
      return symbols(state.checker, state.node).some((symbol) => allowed.includes(symbol));
    },
    promise(context, node) {
      const state = service(context, node); if (!state) return undefined;
      return thenable(state.checker, state.checker.getTypeAtLocation(state.node), state.node);
    },
    background(context, node) {
      const state = service(context, node); if (!state || !ts.isCallExpression(state.node)) return undefined;
      const signature = state.checker.getResolvedSignature(state.node), result = signature && state.checker.getReturnTypeOfSignature(signature);
      if (uncertain(result)) return undefined;
      const argument = state.node.arguments[0], type = argument && state.checker.getTypeAtLocation(argument);
      if (uncertain(type)) return undefined;
      const signatures = type.getCallSignatures(), promises = signatures.map((item) => thenable(state.checker, state.checker.getReturnTypeOfSignature(item), argument));
      if (promises.includes(undefined)) return undefined;
      return { voidReturn: !!(result.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)), asyncArgument: state.node.arguments.length === 1 && promises.length > 0 && promises.every(Boolean) };
    },
    resultExports(context, reference) {
      const state = service(context); if (!state) return undefined;
      const expected = declared(state, reference), module = state.checker.getSymbolAtLocation(state.source);
      if (!expected?.declarations?.length || !module) return undefined;
      const rows = [];
      for (const exported of state.checker.getExportsOfModule(module)) {
        const symbol = unalias(state.checker, exported), place = symbol.valueDeclaration ?? symbol.declarations?.[0];
        if (!place) continue;
        const type = state.checker.getTypeOfSymbolAtLocation(symbol, place);
        for (const signature of type.getCallSignatures()) {
          const returned = state.checker.getReturnTypeOfSignature(signature), value = state.checker.getAwaitedType(returned);
          const matches = (type) => type && [type.aliasSymbol, type.getSymbol?.()].map((item) => unalias(state.checker, item)).includes(expected);
          rows.push({ name: exported.name, valid: !uncertain(value) && (matches(returned) || matches(value)), unresolved: uncertain(value) });
        }
      }
      return rows;
    },
  };
}

// Programs are supplied by the shared semantic context. No project service or candidate plugin runs.
export function typedRuntime(analysis, project, selectedFiles = analysis.files.filter((file) => analysis.scope(project.root, file))) {
  const selected = selectedFiles.filter(script), programs = [];
  for (const config of project.tsconfigs ?? ["tsconfig.json"]) {
    const path = analysis.relative(resolve(analysis.root, project.root, config)), parsed = analysis.compilerConfig(path);
    for (const [key, value] of Object.entries(strictCompilerOptions)) if (parsed.options[key] !== undefined && parsed.options[key] !== value) throw new AnalysisError(path, `${key} conflicts with Plumb's strict compiler policy.`);
    if (!parsed.fileNames.length) throw new AnalysisError(path, "The TypeScript project selects no source files.");
    const options = { ...parsed.options, ...strictCompilerOptions, noEmit: true, incremental: false, composite: false };
    programs.push(analysis.program(analysis.relative(parsed.fileNames[0]), [], options, parsed.fileNames, parsed.projectReferences));
  }
  const covered = selected.filter((file) => programs.some((program) => !!program.getSourceFile(analysis.absolute(file))));
  const missing = selected.filter((file) => typed(file) && !covered.includes(file));
  if (missing.length) throw new AnalysisError(missing[0], "Selected TypeScript source is outside every configured Program; type-aware linting cannot be skipped.");
  for (const file of covered) {
    const bytes = analysis.read(file).replace(/^\uFEFF/, "");
    if (programs.some((program) => { const source = program.getSourceFile(analysis.absolute(file)); return source && source.text.replace(/^\uFEFF/, "") !== bytes; })) throw new AnalysisError(file, "The trusted compiler Program contains different source bytes.");
  }
  const local = (file) => relative(resolve(analysis.root, project.root), analysis.absolute(file)).replaceAll("\\", "/");
  return { programs, typedFiles: covered.map(local), syntaxOnlyFiles: selected.filter((file) => !covered.includes(file)).map(local), typed: typedServices(analysis, programs) };
}
