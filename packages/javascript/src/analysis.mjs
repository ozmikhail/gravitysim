import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";

import ts from "typescript";

import { createModuleResolver } from "../shared/module-resolver.mjs";
import { createCompilerIO } from "../shared/compiler-host.mjs";

export const isScript = (path) => /\.[cm]?[jt]sx?$/.test(path);
export const isTest = (path) =>
  /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
export const literal = (node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
export const walk = (node, visit) => {
  visit(node);
  node.forEachChild((child) => { walk(child, visit); });
};
const slash = (path) => path.split(sep).join("/");
const pattern = (value) => {
  const clean = value.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return clean === "." || clean === "" ? "**" : clean.endsWith("/") ? `${clean}**` : clean;
};

export class AnalysisError extends Error {
  path;
  remedy;
  constructor(path, message, remedy = "Correct the source or configuration so this contract can be fully checked.") {
    super(message);
    this.name = "AnalysisError";
    this.path = path;
    this.remedy = remedy;
  }
}

// Contract scopes share one inventory; source trees and compiler programs are cached per run.
export class Analysis {
  context;
  root;
  files;
  inventory;
  sources = new Map();
  configs = new Map();
  configStack = new Set();
  programs = new Map();
  resolver;
  compilerIO;

  constructor(context) {
    this.context = context;
    this.root = resolve(context.root);
    this.files = [...new Set(context.files.map((file) => this.relative(file)))].sort();
    this.inventory = new Set(this.files);
    this.compilerIO = createCompilerIO(this.root, context, ts);
    this.resolver = createModuleResolver(this.root, this.compilerIO);
  }

  relative(file) {
    const absolute = isAbsolute(file) ? file : resolve(this.root, file.replace(/\\/g, "/"));
    const name = slash(relative(this.root, absolute));
    if (name === ".." || name.startsWith("../") || isAbsolute(name)) {
      throw new AnalysisError("plumb.json", "A semantic input escapes the project root.");
    }
    return name || ".";
  }

  absolute(file, allowMissing = false) {
    const name = this.relative(file);
    if (this.context.safePath) return this.context.safePath(name, { allowMissing });
    const absolute = resolve(this.root, name);
    try {
      const real = realpathSync(absolute);
      const offset = relative(realpathSync(this.root), real);
      if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
        throw new AnalysisError(name, "A semantic input follows a symbolic link outside the project root.");
      }
    } catch (error) {
      if (!(allowMissing && error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (dirname(absolute) !== this.root) this.absolute(dirname(absolute), true);
    }
    return absolute;
  }

  read(file) {
    const name = this.relative(file);
    try {
      return this.context.read ? this.context.read(name) : readFileSync(this.absolute(name), "utf8");
    } catch (error) {
      if (error instanceof AnalysisError) throw error;
      throw new AnalysisError(name, `Cannot read ${name}.`, "Restore the file and include it in the checked inventory.");
    }
  }

  matches(patterns, file) {
    const list = (Array.isArray(patterns) ? patterns : [patterns]).map(pattern);
    const name = this.relative(file);
    return this.context.matches ? this.context.matches(list, name) : list.some((glob) => matchesGlob(name, glob));
  }

  select(patterns, scripts = true) {
    return this.files.filter((file) => (!scripts || isScript(file)) && this.matches(patterns, file));
  }

  scope(folder, file) {
    const prefix = this.relative(folder);
    const name = this.relative(file);
    return prefix === "." || name === prefix || name.startsWith(`${prefix}/`);
  }

  required(patterns) {
    const files = this.select(patterns);
    if (!files.length) throw new AnalysisError("plumb.json", `No script files match ${JSON.stringify(patterns)}.`);
    return files;
  }

  source(file) {
    const name = this.relative(file);
    if (!this.inventory.has(name)) {
      throw new AnalysisError(name, `${name} is absent from the checked inventory.`, "Restore the file or correct the contract and its scope; an excluded input cannot prove this contract.");
    }
    let source = this.sources.get(name);
    if (!source) {
      source = ts.createSourceFile(this.absolute(name), this.read(name), ts.ScriptTarget.Latest, true);
      const errors = source.parseDiagnostics ?? [];
      if (errors.length) {
        throw new AnalysisError(name, `Cannot analyze invalid syntax: ${ts.flattenDiagnosticMessageText(errors[0].messageText, " ")}`);
      }
      this.sources.set(name, source);
    }
    return source;
  }

  compilerConfig(file) {
    const name = this.relative(file);
    let parsed = this.configs.get(name);
    if (!parsed) {
      if (this.configStack.has(name)) throw new AnalysisError(name, "TypeScript project references contain a cycle.");
      this.configStack.add(name);
      try {
        const path = this.absolute(name);
        const loaded = ts.parseConfigFileTextToJson(path, this.read(name));
        if (loaded.error) throw new AnalysisError(name, ts.flattenDiagnosticMessageText(loaded.error.messageText, " "));
        parsed = ts.parseJsonConfigFileContent(loaded.config, this.compilerIO, dirname(path), undefined, path);
        if (parsed.errors.length) {
          throw new AnalysisError(name, parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("; "));
        }
        for (const reference of parsed.projectReferences ?? []) this.compilerConfig(ts.resolveProjectReferencePath(reference));
        this.configs.set(name, parsed);
      } finally {
        this.configStack.delete(name);
      }
    }
    return parsed;
  }

  options(file) {
    const project = (this.context.config.projects ?? [])
      .filter((item) => ["typescript", "react"].includes(item.profile) && this.scope(item.root, file))
      .sort((a, b) => Number(this.scope(a.root, b.root)) - Number(this.scope(b.root, a.root)))[0];
    if (!project) return this.resolver.optionsFor(this.absolute(file));
    const configs = (project.tsconfigs ?? ["tsconfig.json"]).map((name) => this.compilerConfig(resolve(this.root, project.root, name)));
    return (configs.find((config) => config.fileNames.includes(this.absolute(file))) ?? configs[0]).options;
  }

  target(file, specifier, compilerOptions, runtime = false) {
    const from = this.absolute(file);
    const options = compilerOptions ?? this.options(file);
    const target = this.resolver.resolve(from, specifier, options);
    if (target) {
      let offset = slash(relative(this.root, target));
      if (offset.split("/").includes("node_modules")) return undefined;
      if (offset === ".." || offset.startsWith("../") || isAbsolute(offset)) {
        throw new AnalysisError(this.relative(file), `The dependency ${specifier} leaves the checked root.`);
      }
      if (runtime && /\.d\.[cm]?ts$/.test(offset)) {
        const implementation = this.resolver.runtime(from, specifier, options);
        if (!implementation) {
          throw new AnalysisError(this.relative(file), `The runtime dependency ${specifier} resolves only to declarations (${offset}).`, "Include its runtime implementation or correct the resolution settings; declarations cannot prove a runtime dependency graph.");
        }
        offset = this.relative(implementation);
      }
      if (!this.inventory.has(offset)) throw new AnalysisError(this.relative(file), `The dependency ${specifier} resolves to ${offset}, outside the checked inventory.`);
      this.absolute(offset);
      return offset;
    }
    if (specifier.startsWith(".")) {
      const exact = this.relative(resolve(dirname(from), specifier));
      if (this.inventory.has(exact)) return exact;
    }
    if (this.resolver.isLocal(from, specifier, options)) {
      throw new AnalysisError(this.relative(file), `Cannot resolve local dependency ${specifier}.`, "Correct the import or tsconfig resolution settings; unresolved local edges are never skipped.");
    }
    return undefined;
  }

  program(file, extra = [], compilerOptions, rootNames, projectReferences) {
    const options = { ...(compilerOptions ?? { ...this.options(file), allowJs: true }), noEmit: true };
    const roots = [...new Set([...(rootNames ?? this.files.filter(isScript)), ...extra].map((name) => this.absolute(name)))].sort();
    const key = JSON.stringify([options, roots, projectReferences ?? []]);
    let program = this.programs.get(key);
    if (!program) {
      program = ts.createProgram({ rootNames: roots, options, projectReferences, host: this.compilerHost(options) });
      this.programs.set(key, program);
    }
    return program;
  }

  compilerHost(options, overrides = {}) {
    const host = { ...ts.createCompilerHost(options, true), ...this.compilerIO,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      writeFile() { throw new AnalysisError("plumb.json", "A checking compiler cannot write files."); },
      ...overrides,
    };
    if (!overrides.getSourceFile) host.getSourceFile = (file, languageVersion) => {
      const text = host.readFile(file);
      return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true);
    };
    return host;
  }

  issue(rule, file, message, remedy, node) {
    const location = node?.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
    return { rule, path: this.relative(file), message, remedy, ...(location && { line: location.line + 1, column: location.character + 1 }) };
  }
}

// Inline type specifiers keep an empty runtime import under verbatimModuleSyntax.
export const edges = (source) => {
  const found = [];
  walk(source, (node) => {
    if (ts.isImportDeclaration(node) && literal(node.moduleSpecifier)) {
      const clause = node.importClause;
      found.push({ node, specifier: node.moduleSpecifier.text, dynamic: false, typeOnly: clause?.isTypeOnly === true || clause?.phaseModifier === ts.SyntaxKind.TypeKeyword });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && literal(node.moduleSpecifier)) {
      found.push({ node, specifier: node.moduleSpecifier.text, dynamic: false, typeOnly: node.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      found.push({ node, ...(expression && literal(expression) && { specifier: expression.text }), dynamic: false, typeOnly: node.isTypeOnly });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && literal(node.argument.literal)) {
      found.push({ node, specifier: node.argument.literal.text, dynamic: false, typeOnly: true });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      found.push({ node, ...(argument && literal(argument) && { specifier: argument.text }), dynamic: true, typeOnly: false });
    }
  });
  return found;
};
