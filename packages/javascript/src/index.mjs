import { resolve } from "node:path";

import ts from "typescript";
import { planConventions } from "@ozlabs/plumb/conventions";

import { Analysis, AnalysisError, isScript, isTest, literal, walk } from "./analysis.mjs";
import { boundaries, importGraph, lazyModules, manifest, writtenOnce } from "./contracts.mjs";
import { surfaceProblems, surfaceProposal, uniqueExports } from "./exports.mjs";
import { registrations } from "./registrations.mjs";
import { checkConventions, RULES as CONVENTION_RULES } from "./conventions.mjs";
import { checkMetrics, RULES as METRIC_RULES } from "./metrics.mjs";

export { Analysis, AnalysisError } from "./analysis.mjs";

export const RULES = [
  ...CONVENTION_RULES, ...METRIC_RULES,
  { id: "javascript.analysis", description: "Every configured semantic input parses and every local edge used by a contract resolves.", remedy: "Restore the missing input or correct its syntax, compiler configuration or scope.", suppressible: false },
  { id: "contracts.boundaries", description: "Static, type and literal dynamic dependencies respect module boundaries.", remedy: "Route the dependency through an allowed layer or owner.", suppressible: true },
  { id: "contracts.manifests", description: "A literal catalogue covers its entry and direct local runtime dependencies.", remedy: "Correct the source catalogue and remove stale exemptions.", suppressible: true },
  { id: "contracts.registrations", description: "Named synchronous registrars have exactly one direct lexical call in the configured composition function.", remedy: "Use a synchronous non-generator registrar and compose it once directly; runtime execution remains a separate property.", suppressible: true },
  { id: "contracts.lazy-modules", description: "Literal lazy imports, their catalogue and their filenames agree.", remedy: "Keep the lazy-module catalogue and naming scope in agreement.", suppressible: true },
  { id: "contracts.written-once", description: "Selected table literals are not repeated in value positions elsewhere.", remedy: "Import the table's named value.", suppressible: true },
  { id: "contracts.import-graphs", description: "The static runtime dependency graph stays within its allowed package, specifier and file kinds.", remedy: "Remove a refused dependency; this contract does not prove dynamic reachability.", suppressible: true },
  { id: "exports.unique", description: "Owned exported names and renamed reexports have one owner within the selected folders.", remedy: "Give each owned exported name a unique name.", suppressible: true },
  { id: "exports.surface", description: "Each package export condition agrees with its reviewed public names or opt-in declaration-signature snapshot.", remedy: "Review the API change and explicitly propose a new snapshot; fix never updates expectations.", suppressible: true },
  { id: "tests.focused", description: "Conventional test files contain no focused test/it/describe/suite calls or only options.", remedy: "Remove the focus marker so the whole suite runs; custom test wrappers need their own adapter support.", suppressible: true },
  { id: "tests.skipped", description: "Conventional test files contain no skip/todo markers on recognized test calls.", remedy: "Restore the test or record a narrow reviewed exception.", suppressible: true },
];

const testCall = (node) => {
  if (ts.isIdentifier(node)) return { base: node.text, properties: [] };
  if (ts.isCallExpression(node)) return testCall(node.expression);
  if (ts.isPropertyAccessExpression(node)) {
    const path = testCall(node.expression);
    return path && { base: path.base, properties: [...path.properties, node.name.text] };
  }
  if (ts.isElementAccessExpression(node) && literal(node.argumentExpression)) {
    const path = testCall(node.expression);
    return path && { base: path.base, properties: [...path.properties, node.argumentExpression.text] };
  }
  return undefined;
};

const hygiene = (analysis) => {
  const diagnostics = [];
  const names = new Set(["test", "it", "describe", "suite"]);
  const packages = new Set(["node:test", "bun:test", "vitest", "@jest/globals", "@playwright/test", "mocha"]);
  for (const file of analysis.files.filter((path) => isScript(path) && isTest(path))) {
    const source = analysis.source(file);
    const calls = new Set(names);
    const namespaces = new Set();
    const contexts = new Set();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !literal(statement.moduleSpecifier) || !packages.has(statement.moduleSpecifier.text)) continue;
      if (statement.importClause?.name) calls.add(statement.importClause.name.text);
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) if (names.has((binding.propertyName ?? binding.name).text)) calls.add(binding.name.text);
      }
    }
    walk(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      if ((ts.isCallExpression(node.parent) || ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node) return;
      const path = testCall(node.expression);
      if (!path || (!calls.has(path.base) && !(namespaces.has(path.base) && names.has(path.properties[0])) && !(contexts.has(path.base) && path.properties[0] === "test"))) return;
      let focused = path.properties.includes("only");
      let skipped = path.properties.some((name) => ["skip", "todo", "skipIf"].includes(name));
      for (const argument of node.arguments) {
        if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
          const parameter = argument.parameters[0]?.name;
          if (parameter && ts.isIdentifier(parameter)) contexts.add(parameter.text);
        }
        if (!ts.isObjectLiteralExpression(argument)) continue;
        for (const property of argument.properties) {
          if (!ts.isPropertyAssignment(property) || property.initializer.kind === ts.SyntaxKind.FalseKeyword) continue;
          const name = ts.isIdentifier(property.name) || literal(property.name) ? property.name.text : "";
          focused ||= name === "only";
          skipped ||= name === "skip" || name === "todo";
        }
      }
      if (focused) diagnostics.push(analysis.issue("tests.focused", file, "A focused test can leave the rest of the suite unexecuted.", "Remove.only or the only option before submitting this change.", node));
      if (skipped) diagnostics.push(analysis.issue("tests.skipped", file, "A recognized test is skipped or left as a todo.", "Implement the test or record an approved narrow exception with a reason.", node));
    });
  }
  return diagnostics;
};

const incomplete = (error, contract) => ({
  rule: "javascript.analysis",
  path: error instanceof AnalysisError ? error.path : "plumb.json",
  message: `${contract}: ${error instanceof Error ? error.message : "Semantic analysis failed."}`,
  remedy: error instanceof AnalysisError ? error.remedy : "Correct the adapter input or tool installation so the requested analysis can finish.",
  status: "incomplete",
  suppressible: false,
});

// Both check and fix call this read-only function. Contract acceptance is a separate operation.
export const check = (context, shared) => {
  let analysis;
  try { analysis = shared ?? new Analysis(context); }
  catch (error) { return [incomplete(error, "inventory")]; }
  const diagnostics = [];
  const run = (name, inspect) => {
    try { diagnostics.push(...inspect()); }
    catch (error) { diagnostics.push(incomplete(error, name)); }
  };
  const contracts = context.config.contracts ?? {};
  const families = [
    ["boundaries", boundaries], ["manifests", manifest], ["registrations", registrations],
    ["lazyModules", lazyModules], ["writtenOnce", writtenOnce], ["importGraphs", importGraph],
  ];

  for (const [name, inspect] of families) for (const contract of contracts[name] ?? []) run(name, () => inspect(analysis, contract));
  if (context.config.conventions) {
    const roles = planConventions(context);
    run("conventions", () => checkConventions(context, analysis, roles));
    run("role budgets", () => checkMetrics(context, analysis, roles));
  }
  for (const project of context.config.projects ?? []) {
    if (!["typescript", "react"].includes(project.profile)) continue;
    if (project.uniqueExports?.length) run("uniqueExports", () => {
      const patterns = project.uniqueExports.map((folder) => `${analysis.relative(resolve(analysis.root, project.root, folder))}/**`);
      const files = analysis.required(patterns).filter((file) => !isTest(file) && !/\.d\.[cm]?ts$/.test(file));
      if (!files.length) throw new AnalysisError("plumb.json", "The unique-export scope contains no implementation modules.");
      return uniqueExports(analysis, files);
    });
    if (project.surface) run("surface", () => surfaceProblems(analysis, project));
  }
  if (context.config.preset === "ozlabs") run("test hygiene", () => hygiene(analysis));
  return diagnostics.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule) || a.message.localeCompare(b.message));
};

export const snapshot = (context, projectRoot, shared) => {
  const analysis = shared ?? new Analysis(context);
  const projects = (context.config.projects ?? []).filter((project) => project.surface && (!projectRoot || analysis.relative(project.root) === analysis.relative(projectRoot)));
  if (!projects.length) throw new AnalysisError("plumb.json", "No public API surface is configured for the requested project.");
  return projects.map((project) => surfaceProposal(analysis, project));
};
