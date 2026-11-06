import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import ts from "typescript";
import { canonical, digest } from "@ozlabs/plumb/files";

import { AnalysisError, isScript, literal } from "./analysis.mjs";
import { strictCompilerOptions } from "../eslint/typed-policy.mjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => record(value) && Object.keys(value).length === allowed.length && allowed.every((key) => Object.hasOwn(value, key));
const slash = (value) => value.split(sep).join("/");
const inside = (root, path) => { const name = relative(root, path); return !isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`); };
const owned = (analysis, file) => inside(analysis.root, file) && !slash(relative(analysis.root, file)).split("/").includes("node_modules");
const sorted = (entries) => Object.fromEntries([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const label = (value) => typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") && !value.split("/").includes("..") && /^(?:\.\/|workspace:|package:|typescript:)/.test(value);
const modifiers = (node) => ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
const hasModifier = (node, kind) => modifiers(node).some((modifier) => modifier.kind === kind);
const privateMember = (node) => !ts.isConstructorDeclaration(node) && (hasModifier(node, ts.SyntaxKind.PrivateKeyword) || node.name && ts.isPrivateIdentifier(node.name));
const routingIsValid = (value) => {
  if (typeof value !== "string") return false;
  const target = (item) => item === null || typeof item === "string" && !item.includes("\0") || Array.isArray(item) && item.every(target) || record(item) && Object.entries(item).every(([key, entry]) => !key.includes("\0") && target(entry));
  try { const parsed = JSON.parse(value); return parsed !== null && target(parsed) && JSON.stringify(parsed) === value; } catch { return false; }
};

export function signatureSnapshotIsValid(value) {
  if (!keys(value, ["schemaVersion", "exports", "targets", "routing", "signatures", "compiler"]) || value.schemaVersion !== 2 || !routingIsValid(value.routing)) return false;
  if (!keys(value.compiler, ["typescript", "libraries", "options"]) || typeof value.compiler.typescript !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.compiler.typescript) || !hash(value.compiler.libraries)) return false;
  if (!keys(value.compiler.options, ["strictNullChecks", "strictFunctionTypes", "exactOptionalPropertyTypes", "noUncheckedIndexedAccess"]) || !Object.values(value.compiler.options).every((value) => typeof value === "boolean") || !value.compiler.options.strictNullChecks || !value.compiler.options.strictFunctionTypes) return false;
  if (!record(value.exports) || !Object.keys(value.exports).length || !Object.values(value.exports).every((names) => Array.isArray(names) && names.every((name) => typeof name === "string") && new Set(names).size === names.length)) return false;
  if (!record(value.targets) || canonical(Object.keys(value.targets).sort()) !== canonical(Object.keys(value.exports).sort()) || !record(value.signatures)) return false;
  if (!Object.values(value.targets).every((target) => keys(target, ["module", "priority"]) && label(target.module) && Object.hasOwn(value.signatures, target.module) && Array.isArray(target.priority) && target.priority.every((value) => Number.isSafeInteger(value) && value >= 0))) return false;
  return Object.entries(value.signatures).every(([path, item]) => label(path) && keys(item, ["declaration", "references"]) && typeof item.declaration === "string" && !item.declaration.includes("\0") && record(item.references) && Object.entries(item.references).every(([specifier, target]) => specifier && !specifier.includes("\0") && !isAbsolute(specifier) && !/^[a-z]:[\\/]/i.test(specifier) && label(target) && Object.hasOwn(value.signatures, target)));
}

function declarationHost(analysis, options, emitted, observations) {
  const host = analysis.compilerHost(options);
  const originalRead = host.readFile.bind(host);
  host.readFile = (file) => {
    const path = resolve(file);
    if (emitted?.has(path)) return emitted.get(path);
    const value = originalRead(file);
    if (observations.has(path) && observations.get(path) !== value) throw new AnalysisError("plumb.json", "A compiler input changed while constructing API signatures.");
    observations.set(path, value);
    return value;
  };
  host.getCurrentDirectory = () => analysis.root;
  host.getSourceFile = (file, languageVersion, onError) => {
    const path = resolve(file), virtual = emitted?.has(path);
    if (owned(analysis, path) && isScript(path)) {
      const name = analysis.relative(path);
      if (!analysis.inventory.has(name)) throw new AnalysisError(name, "A public signature dependency is outside the checked inventory.");
      analysis.absolute(name);
      if (!virtual) analysis.source(name);
    }
    let text;
    try { text = host.readFile(path); }
    catch (error) { onError?.(error.message); throw error; }
    if (text === undefined) return undefined;
    const source = ts.createSourceFile(path, text, languageVersion, true, virtual ? ts.ScriptKind.TS : undefined);
    if (virtual) source.isDeclarationFile = true;
    if (emitted && isScript(path) && !source.isDeclarationFile) throw new AnalysisError(owned(analysis, path) ? analysis.relative(path) : "plumb.json", "A public dependency has no declaration output; provide its prepared declarations before snapshotting.");
    return source;
  };
  host.writeFile = () => { throw new AnalysisError("plumb.json", "Signature construction cannot write compiler output to the project."); };
  return host;
}

function diagnostics(analysis, values) {
  const errors = values.filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (!errors.length) return;
  const first = errors.find((item) => item.file && owned(analysis, item.file.fileName));
  const path = first ? analysis.relative(first.file.fileName) : "plumb.json";
  const message = errors.map((item) => `TS${item.code}: ${ts.flattenDiagnosticMessageText(item.messageText, " ")}`).join("; ").replaceAll(analysis.root, ".").replaceAll(slash(analysis.root), ".");
  throw new AnalysisError(path, `Cannot construct complete public declarations: ${message}`, "Resolve compiler errors, missing declarations or ambiguous public types before proposing an API contract.");
}

function moduleLabels(analysis, project, host, libraries) {
  const projectRoot = resolve(analysis.root, project.root), cache = new Map();
  return (file) => {
    const path = resolve(file);
    if (cache.has(path)) return cache.get(path);
    let result;
    if (owned(analysis, path)) result = inside(projectRoot, path) ? `./${slash(relative(projectRoot, path))}` : `workspace:${analysis.relative(path)}`;
    else if (libraries.has(path) && /^lib(?:\.[\w.-]+)?\.d\.ts$/.test(basename(path))) result = `typescript:${basename(path)}`;
    else {
      let folder = dirname(path);
      while (true) {
        const source = host.readFile(resolve(folder, "package.json"));
        if (source !== undefined) {
          let manifest;
          try { manifest = JSON.parse(source); } catch { throw new AnalysisError("plumb.json", "A signature type provider has an invalid package manifest."); }
          if (typeof manifest.name === "string" && /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(manifest.name) && typeof manifest.version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) {
            result = `package:${manifest.name}@${manifest.version}/${slash(relative(folder, path))}`; break;
          }
        }
        const parent = dirname(folder);
        if (parent === folder) throw new AnalysisError("plumb.json", "An external signature dependency has no stable package identity; materialize its reviewed declarations inside the checked project.");
        folder = parent;
      }
    }
    cache.set(path, result); return result;
  };
}

function signatureGraph(analysis, program, host, targetFiles, nameOf, libraries, originalProgram) {
  const checker = program.getTypeChecker(), included = new Set(), containers = new Set(), scanned = new Set(), ambient = new Set(), symbols = new Map(), requests = new Map(), records = new Map(), labels = new Map(), rewrites = new Map();
  const sourceOf = (module) => module?.declarations?.find(ts.isSourceFile) ?? module?.declarations?.[0]?.getSourceFile();
  const alias = (symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const error = (node, message) => { const file = node.getSourceFile().fileName; throw new AnalysisError(owned(analysis, file) ? analysis.relative(file) : "plumb.json", message); };
  const statementOf = (node) => { while (node.parent && !ts.isSourceFile(node.parent) && !ts.isModuleBlock(node.parent)) node = node.parent; return node; };

  function sourceRecord(source) {
    const path = resolve(source.fileName);
    if (libraries.has(path)) return undefined;
    if (records.has(source)) return records.get(source);
    const original = originalProgram.getSourceFile(path) ?? source;
    // Emit may remove reference directives. Refuse their unsupported ambient closure before it can disappear.
    if ([original, source].some((file) => file.referencedFiles.length || file.typeReferenceDirectives.length || file.libReferenceDirectives.length || file.hasNoDefaultLib)) error(source, "Triple-slash reference directives are not supported by signature snapshots; use explicit module imports and declaration modules so ambient dependencies can be recorded completely.");
    const name = nameOf(path), duplicate = labels.get(name);
    if (duplicate && duplicate !== source) error(source, `Two distinct type-provider modules share ${name}; use one unambiguous dependency installation.`);
    const item = { name, source, references: new Map() };
    records.set(source, item); labels.set(name, source);
    for (const statement of source.statements) {
      if (!ts.isExternalModule(source) || ts.isNamespaceExportDeclaration(statement) || ts.isModuleDeclaration(statement) && (ts.isStringLiteral(statement.name) || statement.flags & ts.NodeFlags.GlobalAugmentation)) selectAmbient(statement);
      if (ts.isImportDeclaration(statement) && !statement.importClause) {
        included.add(statement); reference(statement.moduleSpecifier);
      }
    }
    return item;
  }

  function selectAmbient(node) {
    if (ambient.has(node)) return;
    ambient.add(node);
    if (ts.isModuleDeclaration(node)) {
      included.add(node);
      for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) containers.add(parent);
      sourceRecord(node.getSourceFile());
      if (!node.body) error(node, "An ambient module without a declaration body cannot provide complete signature evidence.");
      if (ts.isModuleBlock(node.body)) node.body.statements.forEach(selectAmbient);
      else selectAmbient(node.body);
    } else if (ts.isVariableStatement(node)) node.declarationList.declarations.forEach((declaration) => select(declaration, true));
    else if (ts.isExportDeclaration(node)) {
      included.add(node);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const item of node.exportClause.elements) {
          included.add(item);
          if (node.moduleSpecifier) request(reference(node.moduleSpecifier), (item.propertyName ?? item.name).text, true);
          else {
            const target = checker.getExportSpecifierLocalTargetSymbol(item);
            if (!target) error(item, "An ambient export has no resolved declaration.");
            visitSymbol(target, true);
          }
        }
      } else if (node.moduleSpecifier) visitSymbol(reference(node.moduleSpecifier), true);
    } else if (ts.isImportDeclaration(node) && !node.importClause) {
      included.add(node); reference(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const target = checker.getSymbolAtLocation(node.name);
      if (!target) error(node, "An ambient import has no resolved declaration.");
      visitSymbol(target, true);
    } else select(node, true);
  }

  function reference(node) {
    if (!literal(node)) error(node, "A public declaration has a nonliteral module dependency.");
    let module = checker.getSymbolAtLocation(node);
    if (!module) {
      const source = node.getSourceFile();
      const mode = ts.getModeForUsageLocation?.(source, node, program.getCompilerOptions());
      const resolved = ts.resolveModuleName(node.text, source.fileName, program.getCompilerOptions(), host, undefined, undefined, mode).resolvedModule;
      const target = resolved && program.getSourceFile(resolved.resolvedFileName);
      module = target && checker.getSymbolAtLocation(target);
    }
    if (!module) error(node, `The public declaration dependency ${node.text} could not be resolved.`);
    module = alias(module);
    const target = sourceOf(module);
    if (!target) error(node, `The public declaration dependency ${node.text} has no source module.`);
    const origin = sourceRecord(node.getSourceFile()), dependency = sourceRecord(target);
    if (!dependency) error(node, "A module dependency unexpectedly resolves to a global compiler library.");
    const specifier = isAbsolute(node.text) || /^[a-z]:[\\/]/i.test(node.text) ? dependency.name : node.text;
    const previous = origin.references.get(specifier);
    if (previous && previous !== dependency.name) error(node, `The module specifier ${specifier} resolves ambiguously in its public declarations.`);
    origin.references.set(specifier, dependency.name); rewrites.set(node, specifier);
    return module;
  }

  function request(module, name, full = false) {
    let seen = requests.get(module);
    if (!seen) { seen = new Map(); requests.set(module, seen); }
    if (seen.has(name) && (seen.get(name) || !full)) return;
    seen.set(name, full);
    const symbol = checker.getExportsOfModule(module).find((item) => item.name === name);
    if (!symbol) throw new AnalysisError("plumb.json", `A public declaration dependency has no export named ${name}.`);
    visitSymbol(symbol, full);
    const source = sourceOf(module);
    if (!source) return;
    sourceRecord(source);
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const item of statement.exportClause.elements) if (item.name.text === name) {
          included.add(item); containers.add(statement);
          if (statement.moduleSpecifier) request(reference(statement.moduleSpecifier), (item.propertyName ?? item.name).text, full);
        }
      } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause) && statement.exportClause.name.text === name) {
        included.add(statement);
        if (statement.moduleSpecifier) visitSymbol(reference(statement.moduleSpecifier), full);
      } else if (!statement.exportClause && statement.moduleSpecifier && name !== "default") {
        const destination = checker.getSymbolAtLocation(statement.moduleSpecifier), exported = destination && checker.getExportsOfModule(alias(destination)).find((item) => item.name === name);
        if (exported && alias(exported) === alias(symbol)) { included.add(statement); request(reference(statement.moduleSpecifier), name, full); }
      }
    }
  }

  function visitSymbol(symbol, full = false) {
    if (!symbol || symbols.has(symbol) && (symbols.get(symbol) || !full)) return;
    symbols.set(symbol, full);
    if (symbol.flags & ts.SymbolFlags.Alias) {
      for (const declaration of symbol.declarations ?? []) {
        select(declaration);
        const statement = statementOf(declaration);
        if (ts.isImportDeclaration(statement)) {
          const module = reference(statement.moduleSpecifier);
          if (ts.isImportSpecifier(declaration)) request(module, (declaration.propertyName ?? declaration.name).text, full);
          else if (ts.isImportClause(declaration)) request(module, "default", full);
          else if (full) visitSymbol(module, true);
        } else if (ts.isExportSpecifier(declaration)) {
          if (statement.moduleSpecifier) request(reference(statement.moduleSpecifier), (declaration.propertyName ?? declaration.name).text, full);
          else visitSymbol(checker.getExportSpecifierLocalTargetSymbol(declaration), full);
        } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && statement.moduleReference.expression) {
          visitSymbol(reference(statement.moduleReference.expression), full);
        }
      }
      const target = checker.getAliasedSymbol(symbol);
      if (!target.declarations?.length) throw new AnalysisError("plumb.json", `The public symbol ${symbol.name} has no resolved declaration.`);
      visitSymbol(target, full); return;
    }
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isSourceFile(declaration)) sourceRecord(declaration);
      else if (!ts.isTypeParameterDeclaration(declaration) && !ts.isParameter(declaration)) select(declaration, full);
    }
    if (full && symbol.flags & ts.SymbolFlags.Module) for (const entry of checker.getExportsOfModule(symbol)) request(symbol, entry.name, true);
  }

  function select(declaration, full = false) {
    if (libraries.has(resolve(declaration.getSourceFile().fileName))) return;
    const statement = statementOf(declaration);
    const partial = ts.isVariableDeclaration(declaration) || ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration) || ts.isExportSpecifier(declaration);
    const node = partial ? declaration : ts.isModuleDeclaration(declaration) ? declaration : statement;
    included.add(node);
    for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) containers.add(parent);
    sourceRecord(node.getSourceFile());
    if (ts.isModuleDeclaration(node)) {
      if (full) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) visitSymbol(symbol, true);
      }
      return;
    }
    if (scanned.has(node) || ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) return;
    scanned.add(node);
    const inspect = (child) => {
      if (privateMember(child)) return;
      if (child.kind === ts.SyntaxKind.AnyKeyword && owned(analysis, child.getSourceFile().fileName)) error(child, "A public signature contains any; use unknown or an explicit precise API type instead of accepting an incomplete type contract.");
      if (ts.isImportTypeNode(child) && ts.isLiteralTypeNode(child.argument) && literal(child.argument.literal)) {
        const module = reference(child.argument.literal);
        if (child.qualifier) {
          let first = child.qualifier; while (ts.isQualifiedName(first)) first = first.left;
          request(module, first.text, !ts.isQualifiedName(child.qualifier));
          visitSymbol(checker.getSymbolAtLocation(child.qualifier), true);
        } else visitSymbol(module, true);
      }
      if (ts.isIdentifier(child)) {
        const entity = ts.isQualifiedName(child.parent) && child.parent.right === child ? child.parent : child;
        const qualifier = ts.isQualifiedName(entity.parent) && entity.parent.left === entity || ts.isPropertyAccessExpression(entity.parent) && entity.parent.expression === entity;
        visitSymbol(checker.getSymbolAtLocation(child), !qualifier);
      }
      ts.forEachChild(child, inspect);
    };
    inspect(node);
  }

  const targets = new Map();
  for (const target of targetFiles) {
    const source = program.getSourceFile(analysis.absolute(target.file)), module = source && checker.getSymbolAtLocation(source);
    if (!module) throw new AnalysisError(target.file, "The emitted package entry is not an analyzable declaration module.");
    targets.set(target.key, { module: sourceRecord(source).name, priority: target.priority });
    for (const symbol of checker.getExportsOfModule(module)) request(module, symbol.name, true);
  }

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
  const sortNodes = (nodes) => [...nodes].sort((a, b) => {
    const key = (node) => {
      const name = node.name ?? (ts.isVariableStatement(node) ? node.declarationList.declarations[0]?.name : undefined);
      return `${hasModifier(node, ts.SyntaxKind.StaticKeyword) ? "static:" : ""}${name?.text ?? name?.getText?.() ?? (ts.isConstructorDeclaration(node) ? "constructor" : `${node.kind}:${node.moduleSpecifier?.text ?? ""}`)}`;
    };
    const left = key(a), right = key(b); return left < right ? -1 : left > right ? 1 : 0;
  });
  const signatures = new Map();
  for (const item of records.values()) {
    const transformed = ts.transform(item.source, [(context) => {
      const factory = context.factory;
      const statements = (nodes) => sortNodes(nodes.map(retain).filter(Boolean));
      function retain(node) {
        if (!included.has(node) && !containers.has(node)) return undefined;
        if (ts.isModuleDeclaration(node)) return factory.updateModuleDeclaration(node, node.modifiers, node.name, node.body && (ts.isModuleBlock(node.body) ? factory.updateModuleBlock(node.body, statements(node.body.statements)) : retain(node.body)));
        if (ts.isVariableStatement(node)) return factory.updateVariableStatement(node, node.modifiers, factory.updateVariableDeclarationList(node.declarationList, node.declarationList.declarations.filter((entry) => included.has(entry)).map((entry) => ts.visitNode(entry, visit))));
        if (ts.isImportDeclaration(node) && node.importClause) {
          const clause = node.importClause, bindings = clause.namedBindings;
          const named = bindings && (ts.isNamespaceImport(bindings) ? included.has(bindings) ? bindings : undefined : factory.updateNamedImports(bindings, bindings.elements.filter((entry) => included.has(entry))));
          const name = included.has(clause) ? clause.name : undefined;
          if (!name && (!named || ts.isNamedImports(named) && !named.elements.length)) return undefined;
          return factory.updateImportDeclaration(node, node.modifiers, factory.updateImportClause(clause, clause.isTypeOnly, name, named), ts.visitNode(node.moduleSpecifier, visit), node.attributes);
        }
        if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) return factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, factory.updateNamedExports(node.exportClause, node.exportClause.elements.filter((entry) => included.has(entry))), node.moduleSpecifier && ts.visitNode(node.moduleSpecifier, visit), node.attributes);
        return ts.visitNode(node, visit);
      }
      function visit(node) {
        if (rewrites.has(node)) return factory.createStringLiteral(rewrites.get(node));
        if (ts.isClassDeclaration(node)) {
          const hidden = new Set(node.members.filter(privateMember).map((member) => hasModifier(member, ts.SyntaxKind.StaticKeyword)));
          const members = node.members.filter((member) => !privateMember(member)).map((member) => ts.visitEachChild(member, visit, context));
          for (const isStatic of hidden) members.push(factory.createPropertyDeclaration(isStatic ? [factory.createModifier(ts.SyntaxKind.StaticKeyword)] : undefined, factory.createPrivateIdentifier(isStatic ? "#__plumb_private_static" : "#__plumb_private"), undefined, factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword), undefined));
          return factory.updateClassDeclaration(node, node.modifiers, node.name, node.typeParameters?.map((parameter) => ts.visitEachChild(parameter, visit, context)), node.heritageClauses?.map((clause) => ts.visitEachChild(clause, visit, context)), sortNodes(members));
        }
        if (ts.isInterfaceDeclaration(node)) return factory.updateInterfaceDeclaration(node, node.modifiers, node.name, node.typeParameters?.map((parameter) => ts.visitEachChild(parameter, visit, context)), node.heritageClauses?.map((clause) => ts.visitEachChild(clause, visit, context)), sortNodes(node.members.map((member) => ts.visitEachChild(member, visit, context))));
        return ts.visitEachChild(node, visit, context);
      }
      return (source) => factory.updateSourceFile(source, statements(source.statements));
    }]);
    try {
      const declaration = printer.printFile(transformed.transformed[0]).trimEnd();
      signatures.set(item.name, { declaration: `${declaration || (ts.isExternalModule(item.source) ? "export {};" : "")}\n`, references: sorted(item.references) });
    } finally { transformed.dispose(); }
  }
  return { targets: sorted(targets), signatures: sorted(signatures) };
}

export function signatureSurface(analysis, project, compiler, targets, exported, routing) {
  const observations = new Map(), emitted = new Map();
  const output = resolve(analysis.root, ".plumb-signature-output");
  for (const [key, value] of Object.entries(strictCompilerOptions)) if (compiler.options[key] !== undefined && compiler.options[key] !== value) throw new AnalysisError("plumb.json", `${key} conflicts with Plumb's strict signature policy.`);
  const options = { ...compiler.options, ...strictCompilerOptions, noEmit: false, noEmitOnError: true, declaration: true, emitDeclarationOnly: true, declarationMap: false, sourceMap: false, inlineSourceMap: false, incremental: false, composite: false, tsBuildInfoFile: undefined, outFile: undefined, outDir: output, declarationDir: output, stripInternal: false, removeComments: true, allowJs: true, checkJs: true, skipLibCheck: false, skipDefaultLibCheck: false, isolatedDeclarations: false };
  const roots = [...new Set([...compiler.fileNames, ...targets.map((target) => analysis.absolute(target.file))])].sort();
  const host = declarationHost(analysis, options, undefined, observations);
  const program = ts.createProgram({ rootNames: roots, options, host, projectReferences: compiler.projectReferences });
  diagnostics(analysis, ts.getPreEmitDiagnostics(program));
  const result = program.emit(undefined, (file, text, _bom, _error, sources) => {
    if (!/\.d\.[cm]?ts$/.test(file) || sources?.length !== 1) throw new AnalysisError("plumb.json", "The compiler did not produce one complete declaration module per source file.");
    const source = resolve(sources[0].fileName);
    if (emitted.has(source)) throw new AnalysisError("plumb.json", "The compiler produced duplicate declaration modules.");
    emitted.set(source, text);
  }, undefined, true);
  diagnostics(analysis, result.diagnostics);
  if (result.emitSkipped && roots.some((file) => !program.getSourceFile(file)?.isDeclarationFile)) throw new AnalysisError("plumb.json", "The compiler skipped public declaration emission.");
  const virtualOptions = { ...options, noEmit: true };
  const virtualHost = declarationHost(analysis, virtualOptions, emitted, observations);
  const declarations = ts.createProgram({ rootNames: roots, options: virtualOptions, host: virtualHost, projectReferences: compiler.projectReferences });
  diagnostics(analysis, ts.getPreEmitDiagnostics(declarations));
  const libraryFiles = declarations.getSourceFiles().filter((file) => declarations.isSourceFileDefaultLibrary(file));
  const libraries = new Set(libraryFiles.map((file) => resolve(file.fileName)));
  const nameOf = moduleLabels(analysis, project, virtualHost, libraries);
  const graph = signatureGraph(analysis, declarations, virtualHost, targets, nameOf, libraries, program);
  const libraryIdentity = digest(canonical(libraryFiles.map((file) => [nameOf(file.fileName), digest(file.text)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  for (const [file, text] of observations) {
    if (host.readFile(file) !== text) throw new AnalysisError("plumb.json", "A compiler input changed while constructing API signatures.");
  }
  const interpretation = { strictNullChecks: true, strictFunctionTypes: true, exactOptionalPropertyTypes: options.exactOptionalPropertyTypes ?? false, noUncheckedIndexedAccess: options.noUncheckedIndexedAccess ?? false };
  const snapshot = { schemaVersion: 2, exports: exported, routing, ...graph, compiler: { typescript: ts.version, libraries: libraryIdentity, options: interpretation } };
  if (!signatureSnapshotIsValid(snapshot)) throw new AnalysisError("plumb.json", "The compiler did not produce a complete closed public declaration graph.");
  return snapshot;
}
