import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

import { ESLint } from "eslint";
import prettier from "prettier";
import ts from "typescript";
import { isWithin } from "@ozlabs/plumb/files";
import { planAdapters } from "@ozlabs/plumb/adapters";
import { executeSteps } from "@ozlabs/plumb/process";
import { createConfig, getRuleMetadata, scopeProblems, validateOptions } from "./eslint/index.mjs";
import { Analysis } from "./src/analysis.mjs";
import { strictCompilerOptions, typedRuntime } from "./eslint/typed.mjs";
import { check as semanticCheck, snapshot as semanticSnapshot, RULES as SEMANTIC_RULES } from "./src/index.mjs";

const require = createRequire(import.meta.url);
const scripts = /\.[cm]?[jt]sx?$/;
const owned = (ctx, project, file) => isWithin(project.root, file) && !ctx.config.projects.some((other) => ["typescript", "react"].includes(other.profile) && other.root !== project.root && isWithin(project.root, other.root) && isWithin(other.root, file));
const diagnostic = (rule, path, message, remedy, incomplete = false) => ({ rule, path, message, remedy, ...(incomplete ? { status: "incomplete", suppressible: false } : {}) });
const ADAPTER_RULES = [
  { id: "javascript/format", description: "Source follows the pack's formatter policy.", remedy: "Run plumb fix and review the formatting change." },
  { id: "javascript/types", description: "TypeScript passes strict checking without emitting files.", remedy: "Fix the reported type error." },
  { id: "javascript/config", description: "Language policy uses supported data-only configuration.", remedy: "Correct the language configuration; executable policy is not loaded.", suppressible: false },
  { id: "javascript/knip", description: "Configured dead-code, dependency and cycle checks complete.", remedy: "Resolve the dead-code or dependency diagnostic.", suppressible: false },
];
export const rules = () => [...getRuleMetadata(), ...SEMANTIC_RULES, ...ADAPTER_RULES];
export const snapshot = (context, projectRoot) => semanticSnapshot(context, projectRoot);
export { surfaceSnapshotIsValid } from "./src/exports.mjs";
export const plan = (ctx) => planAdapters(ctx).checks.filter((check) => check.adapter === "javascript");
const statusOf = (diagnostics) => diagnostics.some((item) => item.status === "incomplete") ? "incomplete" : diagnostics.length ? "violation" : "pass";

function optionsOf(ctx) {
  const options = ctx.config.javascript ?? {};
  for (const key of ["root", "profile"]) if (key in options) throw new Error(`javascript.${key} is set by projects, not by rule options`);
  validateOptions(options);
  return options;
}
function location(ctx, path) { return relative(ctx.root, path).replaceAll("\\", "/") || "."; }
function packageInfo(name) {
  let folder = dirname(require.resolve(name));
  for (;;) {
    const path = join(folder, "package.json");
    if (existsSync(path)) {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (value.name === name) return { root: folder, ...value };
    }
    const parent = dirname(folder);
    if (parent === folder) throw new Error(`Cannot find metadata for ${name}`);
    folder = parent;
  }
}
function toolVersions() {
  const versions = { eslint: ESLint.version, typescript: ts.version, prettier: prettier.version };
  for (const name of ["@eslint/js", "typescript-eslint", "eslint-plugin-react-hooks", "eslint-plugin-simple-import-sort", "globals"]) versions[name] = packageInfo(name).version;
  return versions;
}

async function lint(ctx, project, options, analysis) {
  const root = ctx.safePath(project.root), results = [], checkedFiles = [];
  const resolver = Object.fromEntries(["resolve", "runtime", "isLocal"].map((method) => [method, (from, specifier) => analysis.resolver[method](from, specifier, analysis.options(from))]));
  const selected = ctx.files.filter((path) => owned(ctx, project, path) && scripts.test(path));
  const typed = typedRuntime(analysis, project, selected);
  const linter = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: createConfig({ ...options, root, profile: project.profile === "react" ? "react" : "backend" }, { resolver, ...typed }), fix: false, cache: false });
  for (const file of selected) {
    const reports = await linter.lintText(ctx.read(file), { filePath: ctx.safePath(file), warnIgnored: true });
    if (!reports.length) results.push(diagnostic("javascript/config", file, "ESLint returned no coverage for this source file.", "Correct the language scope; every selected file must be checked.", true));
    else checkedFiles.push(file);
    for (const report of reports) for (const item of report.messages) {
      const incomplete = item.fatal || !item.ruleId || item.messageId === "unresolved";
      results.push({ ...diagnostic(item.ruleId ? `javascript/${item.ruleId}` : "javascript/config", file, item.message, incomplete ? "Correct the source, resolution or language configuration so the complete file can be checked." : "Resolve the violation in source, or propose a narrow, reasoned exception for review.", incomplete), line: item.line ?? 1, column: item.column ?? 1, ...(item.ruleId === "plumb/directive" ? { suppressible: false } : {}) });
    }
  }
  return { diagnostics: results, coverage: { id: `javascript.lint:${project.root}`, checkedFiles, status: statusOf(results) }, typedCoverage: { root: project.root, typedFiles: typed.typedFiles, syntaxOnlyFiles: typed.syntaxOnlyFiles } };
}

const strictOptions = strictCompilerOptions;
function types(ctx, project, analysis) {
  const diagnostics = [], covered = new Set();
  for (const config of project.tsconfigs ?? ["tsconfig.json"]) {
    const path = location(ctx, resolve(ctx.root, project.root, config));
    const parsed = analysis.compilerConfig(path);
    const options = { ...parsed.options, ...strictOptions, noEmit: true, incremental: false, composite: false };
    for (const [key, expected] of Object.entries(strictOptions)) {
      if (parsed.options[key] !== undefined && parsed.options[key] !== expected) diagnostics.push(diagnostic("javascript/config", path, `${key} conflicts with Plumb's strict compiler policy.`, `Use ${key}: ${expected}; strict defaults are applied by the checker.`, true));
    }
    if (!parsed.fileNames.length) { diagnostics.push(diagnostic("javascript/config", path, "The TypeScript project selects no source files.", "Correct its include/files settings.", true)); continue; }
    const program = analysis.program(location(ctx, parsed.fileNames[0]), [], options, parsed.fileNames, parsed.projectReferences);
    for (const file of program.getSourceFiles()) covered.add(location(ctx, file.fileName));
    for (const item of ts.getPreEmitDiagnostics(program)) {
      const position = item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start) : null;
      const incomplete = !item.file || [2307, 2688, 6053, 6305, 6306, 6310].includes(item.code);
      diagnostics.push({ ...diagnostic("javascript/types", item.file ? location(ctx, item.file.fileName) : path, `TS${item.code}: ${ts.flattenDiagnosticMessageText(item.messageText, "\n")}`, incomplete ? "Restore the missing input, prepare referenced declarations, or correct the compiler configuration; check never emits build files." : "Fix the reported type error; check never emits build files.", incomplete), ...(position ? { line: position.line + 1, column: position.character + 1 } : {}) });
    }
  }
  for (const file of ctx.files.filter((path) => owned(ctx, project, path) && /\.[cm]?tsx?$/.test(path))) {
    if (!covered.has(file)) diagnostics.push(diagnostic("javascript/config", file, "Selected TypeScript source is outside every configured type-checking program.", "Include this source in a configured tsconfig; exclusions cannot silently remove type coverage.", true));
  }
  const selected = ctx.files.filter((path) => owned(ctx, project, path) && /\.[cm]?tsx?$/.test(path));
  return { diagnostics, coverage: { id: `javascript.types:${project.root}`, checkedFiles: selected.filter((file) => covered.has(file)), status: diagnostics.length ? statusOf(diagnostics) : selected.length ? "pass" : "not-applicable" } };
}

async function format(ctx, write) {
  const diagnostics = [], written = [], checkedFiles = [], notApplicable = [];
  const owned = new Set(ctx.ownedFiles ?? []), writable = new Set(ctx.writableFiles ?? ctx.files);
  const options = JSON.parse(readFileSync(new URL("./assets/prettier.json", import.meta.url), "utf8"));
  delete options.$schema;
  for (const path of ctx.files) {
    if (owned.has(path) || (write && !writable.has(path)) || ctx.config.format?.ignore?.some((entry) => ctx.matches(entry.path, path))) continue;
    try {
      const target = ctx.safePath(path), info = await prettier.getFileInfo(target, { resolveConfig: false });
      if (info.ignored) throw new Error("Prettier ignored a selected format input; declare an explicit reviewed Plumb exclusion");
      if (!info.inferredParser) { notApplicable.push({ path, reason: "The pack's formatter has no parser for this file type." }); continue; }
      const before = ctx.read(path), after = await prettier.format(before, { ...options, filepath: target, parser: info.inferredParser });
      checkedFiles.push(path);
      if (before === after) continue;
      if (write) { writeFileSync(target, after); written.push(path); }
      else diagnostics.push(diagnostic("javascript/format", path, "File differs from the pack's formatting policy.", writable.has(path) ? "Run plumb fix and review the source formatting." : "Format this policy or snapshot explicitly and review it; fix does not alter enforcement inputs."));
    } catch (error) { diagnostics.push(diagnostic("javascript/format", path, error.message, "Correct the syntax before formatting.", true)); }
  }
  return { diagnostics, written, coverage: { id: "javascript.format:.", checkedFiles, notApplicable, status: diagnostics.length ? statusOf(diagnostics) : checkedFiles.length ? "pass" : "not-applicable" } };
}

function knipConfiguration(ctx, project) {
  const cwd = ctx.safePath(project.root);
  const executableConfigs = ["knip.ts", "knip.js", "knip.mjs", "knip.cjs", "knip.config.ts", "knip.config.js"];
  if (executableConfigs.some((path) => existsSync(join(cwd, path)))) throw new Error("Use data-only knip.json; executable Knip configs are not accepted");
  const configPath = ctx.safePath(location(ctx, join(cwd, "knip.json")));
  const config = JSON.parse(ctx.read(location(ctx, configPath)));
  if (!config || typeof config !== "object" || Array.isArray(config) || ["preprocessor", "compilers", "reporter"].some((key) => key in config)) throw new Error("knip.json must be a data object without preprocessors, compilers or custom reporters");
  const info = packageInfo("knip"), bin = typeof info.bin === "string" ? info.bin : info.bin.knip;
  return { cwd, configPath, info, bin };
}

export function doctor(ctx) {
  const diagnostics = [], versions = toolVersions();
  optionsOf(ctx);
  const analysis = new Analysis(ctx);
  for (const project of ctx.config.projects.filter((entry) => ["typescript", "react"].includes(entry.profile))) {
    try {
      for (const config of project.tsconfigs ?? ["tsconfig.json"]) {
        const parsed = analysis.compilerConfig(location(ctx, resolve(ctx.root, project.root, config)));
        for (const [key, expected] of Object.entries(strictOptions)) if (parsed.options[key] !== undefined && parsed.options[key] !== expected) throw new Error(`${key} conflicts with Plumb's strict compiler policy`);
      }
      if (project.knip) versions.knip = knipConfiguration(ctx, project).info.version;
    } catch (error) { diagnostics.push(diagnostic("javascript/config", project.root, error.message, "Restore the declared configuration or install its pinned tools before checking.", true)); }
  }
  return { diagnostics, versions };
}

export async function check(ctx, planned = plan(ctx)) {
  const options = optionsOf(ctx), diagnostics = [], checks = [], coverage = [], typedCoverage = [], versions = toolVersions();
  const analysis = new Analysis(ctx);
  const semantic = semanticCheck(ctx, analysis);
  diagnostics.push(...semantic.map((item) => ({ ...item, check: "javascript.contracts:." })));
  const semanticFiles = planned.find((entry) => entry.id === "javascript.contracts:.")?.files ?? [];
  const inspected = semanticFiles.filter((file) => analysis.sources.has(file));
  coverage.push({ id: "javascript.contracts:.", checkedFiles: inspected, notApplicable: semanticFiles.filter((file) => !analysis.sources.has(file)).map((path) => ({ path, reason: "No direct semantic source inspection was required for this file." })), status: semantic.length ? statusOf(semantic) : inspected.length ? "pass" : "not-applicable" });
  const projects = ctx.config.projects.filter((project) => ["typescript", "react"].includes(project.profile));
  const scopedFiles = projects.flatMap((project) => ctx.files.filter((file) => owned(ctx, project, file) && scripts.test(file)).map((file) => relative(ctx.safePath(project.root), ctx.safePath(file)).replaceAll("\\", "/")));
  const policy = scopeProblems(options, scopedFiles).map((message) => ({ ...diagnostic("javascript/config", "plumb.json", message, "Correct the declared rule scope; a configured contract cannot silently match nothing.", true), check: "javascript.policy:." }));
  diagnostics.push(...policy); coverage.push({ id: "javascript.policy:.", checkedFiles: [], status: statusOf(policy) });
  for (const project of projects) {
    try { const result = await lint(ctx, project, options, analysis); diagnostics.push(...result.diagnostics.map((item) => ({ ...item, check: result.coverage.id }))); coverage.push(result.coverage); typedCoverage.push(result.typedCoverage); }
    catch (error) { diagnostics.push({ ...diagnostic("javascript/config", project.root, `ESLint: ${error.message}`, "Correct the trusted language policy and rerun.", true), check: `javascript.lint:${project.root}` }); }
    try { const result = types(ctx, project, analysis); diagnostics.push(...result.diagnostics.map((item) => ({ ...item, check: result.coverage.id }))); coverage.push(result.coverage); }
    catch (error) { diagnostics.push({ ...diagnostic("javascript/config", project.root, `TypeScript: ${error.message}`, "Correct the TypeScript project and rerun.", true), check: `javascript.types:${project.root}` }); }
    if (project.knip) {
      try {
        const { cwd, configPath, info, bin } = knipConfiguration(ctx, project);
        versions.knip = info.version;
        const runtime = process.versions.bun ? "node" : process.execPath;
        const steps = [[], ["--production", "--include", "files,dependencies,unlisted,unresolved"], ["--include", "cycles"]].map((args, index) => ({ id: `knip.${project.root}.${index + 1}`, rule: "javascript/knip", path: project.root, cwd, command: [runtime, join(info.root, bin), "--config", configPath, "--no-progress", ...args], ...(process.versions.bun ? { tool: "node", versionCommand: [runtime, "--version"] } : {}) }));
        const result = await executeSteps(ctx, steps);
        diagnostics.push(...result.diagnostics); checks.push(...result.checks); Object.assign(versions, result.versions);
        coverage.push(...result.checks.map((item) => ({ id: item.id, checkedFiles: [], status: item.status })));
      } catch (error) { diagnostics.push(diagnostic("javascript/config", project.root, `Knip: ${error.message}`, "Install the pinned tool and use data-only configuration.", true)); }
    }
  }
  if (projects.length) { const result = await format(ctx, false); diagnostics.push(...result.diagnostics.map((item) => ({ ...item, check: result.coverage.id }))); coverage.push(result.coverage); }
  for (const item of coverage) if (!checks.some((entry) => entry.id === item.id)) checks.push({ id: item.id, status: item.status });
  return { diagnostics, checks, versions, coverage, typedCoverage };
}

export async function fix(ctx) {
  optionsOf(ctx);
  return format(ctx, true);
}
