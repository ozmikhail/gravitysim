import { isAbsolute, resolve } from "node:path";

import ts from "typescript";
import { canonical } from "@ozlabs/plumb/files";

import { AnalysisError, literal } from "./analysis.mjs";
import { signatureSurface, signatureSnapshotIsValid } from "./signatures.mjs";

const namedExports = (source) => {
  const names = [];
  const take = (node) => {
    if (!node) return;
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
      if (node.text !== "default") names.push({ name: node.text, node });
    } else for (const item of node.elements) if (ts.isBindingElement(item)) take(item.name);
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const item of statement.exportClause.elements) {
          if (!statement.moduleSpecifier || (item.propertyName && item.name.text !== item.propertyName.text)) take(item.name);
        }
      } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) take(statement.exportClause.name);
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword) || modifiers.some((item) => item.kind === ts.SyntaxKind.DefaultKeyword)) continue;
    if (ts.isVariableStatement(statement)) for (const item of statement.declarationList.declarations) take(item.name);
    else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) take(statement.name);
  }
  return names;
};

export const uniqueExports = (analysis, files) => {
  const owners = new Map();
  const diagnostics = [];
  for (const file of files) {
    for (const { name, node } of namedExports(analysis.source(file))) {
      const owner = owners.get(name);
      if (owner && owner !== file) diagnostics.push(analysis.issue("exports.unique", file, `${name} is already exported by ${owner}.`, "Give each owned exported name a unique name within this project's configured folders.", node));
      else owners.set(name, file);
    }
  }
  return diagnostics;
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const exportTargets = (analysis, project) => {
  const manifestPath = analysis.relative(resolve(analysis.root, project.root, "package.json"));
  let manifest;
  try { manifest = JSON.parse(analysis.read(manifestPath)); }
  catch (error) {
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError(manifestPath, "The package manifest is not valid JSON.");
  }
  if (!isRecord(manifest) || !("exports" in manifest)) throw new AnalysisError(manifestPath, "A surface contract requires an explicit package exports map.");
  const targets = [];
  const append = (key, target, conditions, priority = []) => {
    const label = conditions.length ? `${key} [${conditions.join("/")}]` : key;
    if (target === null) return;
    if (typeof target === "string") {
      if (!target.startsWith("./") || target.split("/").includes("..") || target.includes("\\")) throw new AnalysisError(manifestPath, `The export ${label} must target a package-relative path beginning with ./ without traversal.`);
      if (!/\.[cm]?[jt]sx?$/.test(target)) return;
      if (target.includes("*")) {
        if ((key.match(/\*/g) ?? []).length !== 1) throw new AnalysisError(manifestPath, `The export ${label} needs exactly one subpath wildcard to expand its target.`);
        const parts = target.split("*");
        const expression = new RegExp(`^${escape(parts[0])}(.*)${parts.slice(1).map(escape).join("\\1")}$`);
        const candidates = analysis.files.filter((file) => analysis.scope(project.root, file));
        let expanded = 0;
        for (const file of candidates) {
          const folder = analysis.relative(project.root);
          const local = `./${folder === "." ? file : file.slice(folder.length + 1)}`;
          const match = expression.exec(local);
          if (match) { targets.push({ key: label.replace("*", match[1]), file, priority }); expanded++; }
        }
        if (!expanded) throw new AnalysisError(manifestPath, `The export ${label} matches no checked script files.`, "Run the explicit preparation step and include its outputs, or correct the export map.");
      } else targets.push({ key: label, file: analysis.relative(resolve(analysis.root, project.root, target)), priority });
      return;
    }
    if (Array.isArray(target)) {
      if (!target.length) throw new AnalysisError(manifestPath, `The export ${label} has no fallback target.`);
      target.forEach((item, index) => append(key, item, [...conditions, `fallback:${index}`], [...priority, index]));
    } else if (isRecord(target)) {
      for (const [index, [condition, value]] of Object.entries(target).entries()) {
        if (condition.startsWith(".")) throw new AnalysisError(manifestPath, `The conditional export ${label} contains a misplaced subpath key.`);
        append(key, value, [...conditions, condition], [...priority, index]);
      }
    } else throw new AnalysisError(manifestPath, `The export ${label} is not a valid export target.`);
  };
  const map = manifest.exports;
  if (isRecord(map) && Object.keys(map).some((key) => key.startsWith("."))) {
    for (const [index, [key, value]] of Object.entries(map).entries()) {
      if (key !== "." && !key.startsWith("./")) throw new AnalysisError(manifestPath, "An exports map cannot mix condition keys and subpath keys.");
      append(key, value, [], [index]);
    }
  } else append(".", map, []);
  if (!targets.length) throw new AnalysisError(manifestPath, "The exports map selects no script entries for this surface contract.");
  return { targets: targets.sort((a, b) => a.key.localeCompare(b.key)), routing: JSON.stringify(map) };
};

const aliasIsTypeOnly = (symbol) => Boolean(symbol.declarations?.length && symbol.declarations.every((declaration) => {
  if (ts.isExportDeclaration(declaration)) return declaration.isTypeOnly;
  if (ts.isExportSpecifier(declaration)) return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
  if (ts.isNamespaceExport(declaration)) return declaration.parent.isTypeOnly;
  return false;
}));

export const surface = (analysis, project) => {
  if (!project.surface) throw new AnalysisError("plumb.json", "No surface contract is configured for this project.");
  const configPath = analysis.relative(resolve(analysis.root, project.root, project.surface.tsconfig ?? "tsconfig.json"));
  const compiler = analysis.compilerConfig(configPath);
  const { targets, routing } = exportTargets(analysis, project);
  for (const target of targets) analysis.source(target.file);
  const program = analysis.program(targets[0].file, targets.map((target) => target.file), { ...compiler.options, allowJs: true }, undefined, compiler.projectReferences);
  const checker = program.getTypeChecker();
  const typeOnlyThroughStars = (module, name, seen = new Set()) => {
    if (seen.has(module)) return true;
    const next = new Set([...seen, module]);
    const symbol = checker.getExportsOfModule(module).find((item) => item.name === name);
    if (!symbol || aliasIsTypeOnly(symbol)) return true;
    const owners = new Set(module.declarations ?? []);
    if (symbol.declarations?.some((declaration) => {
      for (let parent = declaration; parent; parent = parent.parent) if (owners.has(parent)) return true;
      return false;
    })) return false;
    let throughStar = false;
    for (const owner of owners) {
      let body = owner;
      while (ts.isModuleDeclaration(body) && body.body) body = body.body;
      if (!ts.isSourceFile(body) && !ts.isModuleBlock(body)) continue;
      for (const statement of body.statements) {
        if (!ts.isExportDeclaration(statement) || statement.exportClause || !statement.moduleSpecifier) continue;
        const target = checker.getSymbolAtLocation(statement.moduleSpecifier);
        if (!target || !checker.getExportsOfModule(target).some((item) => item.name === name)) continue;
        throughStar = true;
        if (!statement.isTypeOnly && !typeOnlyThroughStars(target, name, next)) return false;
      }
    }
    return throughStar;
  };
  const visited = new Set();
  const verify = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    analysis.source(file);
    const source = program.getSourceFile(analysis.absolute(file));
    if (!source) throw new AnalysisError(file, "The compiler omitted an exported module.");
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !literal(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const target = analysis.target(file, specifier, compiler.options);
      if (!checker.getSymbolAtLocation(statement.moduleSpecifier)) throw new AnalysisError(file, `The reexported module ${specifier} could not be resolved.`);
      if (target && /\.[cm]?[jt]sx?$/.test(target)) verify(target);
    }
  };
  const exported = {};
  for (const { key, file } of targets) {
    verify(file);
    const source = program.getSourceFile(analysis.absolute(file));
    const module = source && checker.getSymbolAtLocation(source);
    if (!source || !module) throw new AnalysisError(file, "The package export target is not an analyzable module.");
    exported[key] = checker.getExportsOfModule(module).map((symbol) => {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      if (!target.declarations?.length) throw new AnalysisError(file, `The exported symbol ${symbol.name} could not be resolved.`);
      const typeOnly = typeOnlyThroughStars(module, symbol.name);
      return `${symbol.name}${typeOnly || !(target.flags & ts.SymbolFlags.Value) ? " (type)" : ""}`;
    }).sort();
  }
  return project.surface.signatures ? signatureSurface(analysis, project, compiler, targets, exported, routing) : { schemaVersion: 1, exports: exported };
};

export const surfaceSnapshotIsValid = (value) => signatureSnapshotIsValid(value) || (
  isRecord(value) && value.schemaVersion === 1 && Object.keys(value).every((key) => ["schemaVersion", "exports"].includes(key)) &&
  isRecord(value.exports) && Object.values(value.exports).every((names) => Array.isArray(names) && names.every((name) => typeof name === "string") && new Set(names).size === names.length));

const snapshotPath = (analysis, project) => {
  const name = project.surface?.snapshot;
  if (typeof name !== "string" || !name.endsWith(".surface.json") || isAbsolute(name) || name.replaceAll("\\", "/").split("/").includes("..")) {
    throw new AnalysisError("plumb.json", "A surface snapshot must be a project-relative *.surface.json data file.");
  }
  const path = analysis.relative(resolve(analysis.root, project.root, name));
  analysis.absolute(path, true);
  return path;
};

export const surfaceProblems = (analysis, project) => {
  const path = snapshotPath(analysis, project);
  const current = surface(analysis, project);
  let before;
  try { before = JSON.parse(analysis.read(path)); }
  catch { return [analysis.issue("exports.surface", path, "The public API snapshot is missing or unreadable.", "Run plumb snapshot explicitly, review its proposal and accept the intended API contract.")]; }
  if (!surfaceSnapshotIsValid(before)) throw new AnalysisError(path, "The public API snapshot must be a valid schemaVersion 1 name contract or schemaVersion 2 signature contract.");
  if (before.schemaVersion !== current.schemaVersion) throw new AnalysisError(path, `This surface mode requires schemaVersion ${current.schemaVersion}; explicitly migrate the dedicated snapshot with plumb snapshot and review it.`);
  const changes = [];
  for (const key of new Set([...Object.keys(before.exports), ...Object.keys(current.exports)])) {
    const was = new Set(before.exports[key] ?? []);
    const now = new Set(current.exports[key] ?? []);
    if (!(key in before.exports)) changes.push(`+ entry ${key}`);
    if (!(key in current.exports)) changes.push(`- entry ${key}`);
    changes.push(...[...now].filter((name) => !was.has(name)).map((name) => `+ ${name} at ${key}`));
    changes.push(...[...was].filter((name) => !now.has(name)).map((name) => `- ${name} at ${key}`));
  }
  if (current.schemaVersion === 2) {
    if (before.routing !== current.routing) changes.push("~ ordered package export routing, including blocked and non-script branches");
    for (const key of new Set([...Object.keys(before.targets), ...Object.keys(current.targets)])) if (canonical(before.targets[key]) !== canonical(current.targets[key])) changes.push(`~ export target ${key}`);
    for (const file of new Set([...Object.keys(before.signatures), ...Object.keys(current.signatures)])) if (canonical(before.signatures[file]) !== canonical(current.signatures[file])) changes.push(`${file in before.signatures ? file in current.signatures ? "~" : "-" : "+"} declarations ${file}`);
    if (canonical(before.compiler) !== canonical(current.compiler)) changes.push("~ TypeScript compiler or standard-library evidence");
  }
  return changes.length ? [analysis.issue("exports.surface", path, `The public ${current.schemaVersion === 2 ? "API signature contract" : "names"} changed: ${changes.sort().join("; ")}.`, "Review the API change and run plumb snapshot explicitly; fix never updates this contract. Exact signature agreement does not prove behavioral or backward compatibility.")] : [];
};

export const surfaceProposal = (analysis, project) => ({
  path: snapshotPath(analysis, project),
  content: `${JSON.stringify(surface(analysis, project), null, 2)}\n`,
});
