import { isAbsolute, relative } from "node:path";

import ts from "typescript";
import { planConventions, validateConventions } from "@ozlabs/plumb/conventions";
import { globMatches } from "@ozlabs/plumb/files";
import { strictCompilerOptions } from "../eslint/typed-policy.mjs";
import { Analysis, AnalysisError, edges, isScript, literal, walk } from "./analysis.mjs";

export const RULES = [
  ["conventions.analysis", "Declared JavaScript role contracts have complete, supported semantic inputs.", false],
  ["conventions.imports", "Literal and resolved dependencies obey their role's allowed and denied scopes.", true],
  ["conventions.exports", "A role's resolved ECMAScript exports obey required and allowed names.", true],
  ["conventions.nodes", "Selected declarations satisfy positive role shape counts.", true],
  ["conventions.types", "A concrete exported value is assignable to its declared contract type.", true],
].map(([id, description, suppressible]) => ({ id, description, suppressible, remedy: "Correct the source to satisfy its role contract; missing semantic evidence cannot be excepted." }));

const incomplete = (error, file, label) => ({ rule: "conventions.analysis", path: error instanceof AnalysisError ? error.path : file,
  message: `${label}: ${error.message}`, remedy: error instanceof AnalysisError ? error.remedy : "Restore the selected compiler/source inputs and use supported declaration contracts.", status: "incomplete", suppressible: false });
const unalias = (checker, symbol) => {
  const seen = new Set();
  while (symbol?.flags & ts.SymbolFlags.Alias) {
    if (seen.has(symbol)) return undefined;
    seen.add(symbol); symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
};
const exportedSymbol = (checker, symbol) => symbol && unalias(checker, checker.getExportSymbolOfSymbol(symbol));
const typeDeclaration = (symbol) => symbol.valueDeclaration ?? symbol.declarations?.[0];

function observeProgram(analysis, program) {
  for (const source of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(source)) continue;
    const file = relative(analysis.root, source.fileName).replaceAll("\\", "/");
    if (file.split("/").includes("node_modules") && program.isSourceFileFromExternalLibrary(source)) continue;
    if (file === ".." || file.startsWith("../") || isAbsolute(file)) throw new AnalysisError("plumb.json", "A convention compiler input escapes the checked source root.");
    const parsed = analysis.source(file);
    if (source.text !== parsed.text && source.text !== parsed.text.replace(/^\uFEFF/, "")) throw new AnalysisError(file, "The compiler Program contains different source text from the selected input.");
  }
}

function exportView(analysis, file, program) {
  analysis.source(file);
  program ??= analysis.program(file, [], { ...analysis.options(file), allowJs: true, noEmit: true }, [file]);
  const checker = program.getTypeChecker(), source = program.getSourceFile(analysis.absolute(file));
  if (!source) throw new AnalysisError(file, "The compiler Program does not include this selected source.");
  observeProgram(analysis, program);
  const visited = new Set();
  const verify = (path) => {
    if (visited.has(path)) return;
    visited.add(path);
    const selected = program.getSourceFile(analysis.absolute(path));
    if (!selected) throw new AnalysisError(path, "A reexported source is absent from the compiler Program.");
    if (selected.commonJsModuleIndicator || selected.statements.some((node) => ts.isExportAssignment(node) && node.isExportEquals)) throw new AnalysisError(path, "Export conventions support ECMAScript modules; CommonJS/export-equals shapes are not supported.");
    for (const statement of selected.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
      if (!literal(statement.moduleSpecifier)) throw new AnalysisError(path, "A reexport needs a literal module specifier.");
      const target = analysis.target(path, statement.moduleSpecifier.text, program.getCompilerOptions());
      if (!checker.getSymbolAtLocation(statement.moduleSpecifier)) throw new AnalysisError(path, `Cannot resolve reexport ${statement.moduleSpecifier.text}.`);
      if (target) verify(target);
    }
  };
  verify(file);
  const module = checker.getSymbolAtLocation(source);
  const symbols = module ? checker.getExportsOfModule(module) : [];
  const targets = new Set();
  for (const symbol of symbols) {
    const target = exportedSymbol(checker, symbol);
    if (!target?.declarations?.length) throw new AnalysisError(file, `Export ${symbol.name} could not be resolved to a declaration.`);
    targets.add(target);
  }
  return { program, checker, source, symbols, targets };
}

function imports(analysis, file, role, source) {
  const diagnostics = [];
  for (const edge of edges(source)) {
    if (!edge.specifier) throw new AnalysisError(file, `Role ${role.id}: a computed import cannot prove the declared import boundary.`);
    const deniedLiteral = role.imports.deny && globMatches(role.imports.deny, edge.specifier);
    const target = deniedLiteral ? undefined : analysis.target(file, edge.specifier, undefined, !edge.typeOnly);
    const matches = (patterns) => globMatches(patterns, edge.specifier) || !!target && globMatches(patterns, target);
    if (deniedLiteral || role.imports.deny && matches(role.imports.deny) || role.imports.allow && !matches(role.imports.allow)) {
      diagnostics.push(analysis.issue("conventions.imports", file, `Role ${role.id} does not allow dependency ${target ?? edge.specifier}.`, "Route this dependency through an allowed module or review a narrow boundary exception.", edge.node));
    }
  }
  return diagnostics;
}

function exportsOf(analysis, file, role, view) {
  const names = view.symbols.map((symbol) => symbol.name), diagnostics = [];
  for (const name of role.exports.require ?? []) if (!names.includes(name)) diagnostics.push(analysis.issue("conventions.exports", file, `Role ${role.id} requires export ${name}.`, "Declare or reexport the required public name."));
  for (const name of names) if (role.exports.allow && !role.exports.allow.includes(name) || role.exports.name && !new RegExp(role.exports.name).test(name)) diagnostics.push(analysis.issue("conventions.exports", file, `Role ${role.id} does not allow export ${name}.`, "Keep only public names allowed by this role."));
  return diagnostics;
}

const kindOf = (node) => {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isVariableDeclaration(node)) return "variable";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "property";
  if (ts.isConstructorDeclaration(node)) return "constructor";
};
const topLevel = (node) => ts.isSourceFile(node.parent) || ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent);
const bindingNames = (name) => ts.isIdentifier(name) ? [name] : name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
function namesOf(node) {
  if (ts.isVariableDeclaration(node)) return bindingNames(node.name).map((name) => ({ name: name.text, node: name }));
  if (ts.isConstructorDeclaration(node)) return [{ name: "constructor", node }];
  if (!node.name) return [{ name: ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? "default" : undefined, node }];
  const name = ts.isComputedPropertyName(node.name) ? node.name.expression : node.name;
  return [{ name: ts.isIdentifier(name) && !ts.isComputedPropertyName(node.name) || ts.isPrivateIdentifier(name) || literal(name) || ts.isNumericLiteral(name) ? name.text : undefined, node: node.name }];
}

function nodes(analysis, file, role, assertion, source, view) {
  const matches = [];
  walk(source, (node) => {
    const kind = kindOf(node), selection = assertion.select;
    if (!kind || !selection.kinds.includes(kind) || selection.topLevel !== undefined && topLevel(node) !== selection.topLevel) return;
    for (const name of namesOf(node)) {
      if (selection.names && name.name === undefined) throw new AnalysisError(file, `Assertion ${assertion.id}: a computed declaration name cannot be selected reliably.`);
      if (selection.names && !selection.names.includes(name.name)) continue;
      if (selection.exported !== undefined) {
        const symbol = exportedSymbol(view.checker, view.checker.getSymbolAtLocation(name.node));
        const exported = view.targets.has(symbol) || [...view.targets].some((target) => target.declarations?.includes(node));
        if (selection.exported !== exported) continue;
      }
      matches.push(node);
    }
  });
  const min = assertion.count.min ?? 0, max = assertion.count.max ?? Infinity;
  return matches.length >= min && matches.length <= max ? [] : [analysis.issue("conventions.nodes", file,
    `Role ${role.id}, assertion ${assertion.id}: matched ${matches.length} declarations; expected ${min}..${max === Infinity ? "unbounded" : max}.`,
    "Add or reshape the required declarations, or remove declarations beyond the approved count.", matches[0])];
}

// Assignability involving any, unknown, never or uninstantiated generic shapes is not proof.
function concrete(checker, program, type, place, file, seen = new Set()) {
  if (!type || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.TypeParameter | ts.TypeFlags.Conditional | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Index | ts.TypeFlags.Substitution)) throw new AnalysisError(file, "The assignability contract contains an unsafe or unevaluated type (any, unknown, never or an uninstantiated generic).");
  if (seen.has(type)) return;
  if (seen.size >= 2048) throw new AnalysisError(file, "The assignability contract exceeds the bounded type-graph inspection limit.");
  seen.add(type);
  if (type.flags & (ts.TypeFlags.Union | ts.TypeFlags.Intersection)) { for (const part of type.types) concrete(checker, program, part, place, file, seen); return; }
  if (!(type.flags & ts.TypeFlags.Object)) return;
  const args = [...type.aliasTypeArguments ?? [], ...(type.objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(type) : [])];
  for (const argument of args) concrete(checker, program, argument, place, file, seen);
  const declarations = type.getSymbol()?.declarations ?? [];
  if (declarations.length && declarations.every((node) => program.isSourceFileDefaultLibrary(node.getSourceFile()))) return;
  for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
    if (signature.typeParameters?.length) throw new AnalysisError(file, "Generic call signatures must be instantiated before they can prove a role type contract.");
    for (const parameter of signature.getParameters()) concrete(checker, program, checker.getTypeOfSymbolAtLocation(parameter, typeDeclaration(parameter) ?? place), place, file, seen);
    concrete(checker, program, checker.getReturnTypeOfSignature(signature), place, file, seen);
  }
  for (const property of checker.getPropertiesOfType(type)) concrete(checker, program, checker.getTypeOfSymbolAtLocation(property, typeDeclaration(property) ?? place), place, file, seen);
  for (const index of checker.getIndexInfosOfType(type)) concrete(checker, program, index.type, place, file, seen);
}

function assignable(analysis, file, role, assertion) {
  const config = analysis.compilerConfig(assertion.tsconfig);
  for (const [key, expected] of Object.entries(strictCompilerOptions)) if (config.options[key] !== undefined && config.options[key] !== expected) throw new AnalysisError(assertion.tsconfig, `${key} conflicts with the strict role type contract.`);
  if (!config.fileNames.length) throw new AnalysisError(assertion.tsconfig, "The contract tsconfig selects no source files.");
  const options = { ...config.options, ...strictCompilerOptions, noEmit: true, incremental: false, composite: false };
  const program = analysis.program(file, [], options, config.fileNames, config.projectReferences);
  observeProgram(analysis, program);
  analysis.source(assertion.contract.file);
  if (!program.getSourceFile(analysis.absolute(file)) || !program.getSourceFile(analysis.absolute(assertion.contract.file))) throw new AnalysisError(file, "The declared tsconfig must include both the checked source and its contract symbol's file.");
  const errors = ts.getPreEmitDiagnostics(program).filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new AnalysisError(errors[0].file ? analysis.relative(errors[0].file.fileName) : assertion.tsconfig, `The contract Program has compiler errors: TS${errors[0].code}: ${ts.flattenDiagnosticMessageText(errors[0].messageText, " ")}`);
  const source = exportView(analysis, file, program), contract = exportView(analysis, assertion.contract.file, program);
  const exported = source.symbols.find((symbol) => symbol.name === assertion.export);
  if (!exported) return [analysis.issue("conventions.types", file, `Role ${role.id}, assertion ${assertion.id}: required value export ${assertion.export} is missing.`, "Export the concrete value required by this role.")];
  const actual = unalias(source.checker, exported), expected = unalias(source.checker, contract.symbols.find((symbol) => symbol.name === assertion.contract.symbol));
  if (!expected || !(expected.flags & ts.SymbolFlags.Type)) throw new AnalysisError(assertion.contract.file, `Contract symbol ${assertion.contract.symbol} must be an exported declared type.`);
  if (!(actual.flags & ts.SymbolFlags.Value)) return [analysis.issue("conventions.types", file, `${assertion.export} is a type-only export; role ${role.id} requires a value.`, "Export a value implementing the declared type contract.")];
  const place = typeDeclaration(actual), sourceType = source.checker.getTypeOfSymbolAtLocation(actual, place), targetType = source.checker.getDeclaredTypeOfSymbol(expected);
  concrete(source.checker, program, sourceType, place, file);
  concrete(source.checker, program, targetType, typeDeclaration(expected), assertion.contract.file);
  return source.checker.isTypeAssignableTo(sourceType, targetType) ? [] : [analysis.issue("conventions.types", file,
    `Role ${role.id}, assertion ${assertion.id}: export ${assertion.export} is not assignable to ${assertion.contract.symbol} from ${assertion.contract.file}.`,
    "Implement the declared contract in source; a type assertion does not establish runtime behavior.", place)];
}

export function checkConventions(context, shared, suppliedPlan) {
  const diagnostics = [];
  if (!context.config.conventions) return diagnostics;
  let analysis, plan;
  try { validateConventions(context.config.conventions); analysis = shared ?? new Analysis(context); plan = suppliedPlan ?? planConventions(context); }
  catch (error) { return [incomplete(error, "plumb.json", "conventions")]; }
  const run = (file, label, inspect) => { try { diagnostics.push(...inspect()); } catch (error) { diagnostics.push(incomplete(error, file, label)); } };
  for (const role of context.config.conventions.roles) {
    if (!role.imports && !role.exports && !role.javascript) continue;
    const files = plan.roles.find((entry) => entry.id === role.id)?.files ?? [];
    if (!files.length) { diagnostics.push(incomplete(new Error("Role has no unambiguously owned selected source files."), "plumb.json", role.id)); continue; }
    for (const file of files) {
      if (!isScript(file)) { diagnostics.push(incomplete(new Error("Import, export and JavaScript shape conventions require the JavaScript adapter and a JS/TS source file."), file, role.id)); continue; }
      let source;
      try { source = analysis.source(file); }
      catch (error) { diagnostics.push(incomplete(error, file, role.id)); continue; }
      if (role.imports) run(file, role.id, () => imports(analysis, file, role, source));
      let view;
      const getView = () => view ??= exportView(analysis, file);
      if (role.exports) run(file, role.id, () => exportsOf(analysis, file, role, getView()));
      for (const assertion of role.javascript?.nodes ?? []) run(file, `${role.id}/${assertion.id}`, () => {
        const selected = assertion.select.exported === undefined ? source : getView().source;
        return nodes(analysis, file, role, assertion, selected, view);
      });
      for (const assertion of role.javascript?.assignable ?? []) run(file, `${role.id}/${assertion.id}`, () => assignable(analysis, file, role, assertion));
    }
  }
  return diagnostics.sort((left, right) => left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0) || left.rule.localeCompare(right.rule) || left.message.localeCompare(right.message));
}
