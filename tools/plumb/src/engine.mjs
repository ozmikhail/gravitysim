import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonical, digest, globMatches, inventory, isWithin, normalize, safePath, snapshot } from "./files.mjs";
import { loadConfig } from "./config.mjs";
import * as contracts from "./contracts.mjs";
import * as assets from "./assets.mjs";
import * as native from "./native.mjs";
import * as comments from "./comments.mjs";
import { applyExceptions, isPolicyFile, RULES as POLICY_RULES } from "./policy.mjs";
import * as adapters from "./adapters.mjs";
import * as verification from "./verification.mjs";
import * as tasks from "./task.mjs";
import { copyWorkspace, loadInputs, materializeInputs } from "./workspace.mjs";
import { scaffold } from "./scaffold.mjs";
import { attachOrigins, enrichDiagnostics } from "./diagnostics.mjs";
import { prepareCache } from "./cache.mjs";
import * as policyTests from "./policy-tests.mjs";
import * as conventions from "./conventions.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_RUN = Symbol("policy fixture invocation");
const ENGINE_RULES = [
  ["config.invalid", "Policy must be valid, data-only configuration."],
  ["inventory.unsafe", "Inputs must remain inside the repository and cannot be symlinks."],
  ["projects.scope", "Every configured project must have a readable source scope."],
  ["projects.uncovered", "The OzLabs preset requires a profile for every supported source file."],
  ["tools.missing", "A configured tool must be installed."],
  ["tools.version", "Pinned tool versions must match the active toolchain."],
  ["run.failed", "A check that cannot finish is incomplete."],
  ["run.mutated", "Check must leave source and policy files unchanged."],
  ["run.subject", "The exact source subject and approved inputs must be readable and stable."],
  ["native.scope", "Native profiles need complete source and build inputs."],
].map(([id, description]) => ({ id, description, remedy: "Resolve the reported configuration or tool failure and run the full check again.", suppressible: false }));
export const coreRules = () => [...ENGINE_RULES, ...POLICY_RULES, ...[contracts, assets, native, comments, adapters, verification, tasks, policyTests, conventions].flatMap((module) => module.RULES ?? [])];
const failure = (rule, path, message, remedy = "Resolve the error and rerun the full check.") => ({ rule, path, message, remedy, status: "incomplete", suppressible: false });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sortDiagnostics = (list) => list.sort((a, b) => compare(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0) || compare(a.rule, b.rule) || compare(a.message, b.message));

export function context(options = {}) {
  const configFile = normalize(options.configFile ?? "plumb.json");
  const found = inventory(options.root ?? process.cwd());
  const loaded = loadConfig(found.root, configFile, options.policy);
  const registry = options.registry ?? adapters.loadAdapterRegistry(options.adapters, options.originalRoot ?? found.root);
  const protectedFiles = loaded.policyInputs.map((input) => relative(found.root, input.path).replaceAll("\\", "/")).filter((path) => path !== ".." && !path.startsWith("../") && !isAbsolute(path));
  const publicOrigin = (origin) => { const path = relative(found.root, origin.path).replaceAll("\\", "/"); return path !== ".." && !path.startsWith("../") && !isAbsolute(path) ? { ...origin, path, source: "repository" } : { ...origin, source: "external" }; };
  const origins = Object.fromEntries(Object.entries(loaded.origins).map(([pointer, entries]) => [pointer, entries.map(publicOrigin)]));
  const policySources = loaded.policyInputs.map(publicOrigin);
  if ((loaded.config.generated ?? []).some((entry) => entry.path === configFile)) throw new Error("Sync cannot generate its own policy file");
  const ownedFiles = assets.assetsFor(loaded.config).map((file) => file.path);
  const databases = loaded.config.projects.filter((project) => project.profile === "cpp").map((project) => `${project.compileCommands}/compile_commands.json`);
  const explicit = [...ownedFiles, ...databases, ...protectedFiles, ...(loaded.config.files?.required ?? []), ...(loaded.config.docs?.index ? [loaded.config.docs.index] : []), ...(loaded.config.preset === "ozlabs" ? ["AGENTS.md"] : [])];
  const allFiles = [...new Set([...found.files, ...explicit.filter((path) => { try { return existsSync(safePath(found.root, path)); } catch { return false; } })])].sort();
  const files = found.files.filter((path) => !loaded.config.exclude.some((entry) => globMatches(entry.files, path)));
  const inputs = new Map(), compilerInputs = new Map(), compilerDirectories = new Map();
  const remember = (map, path, hash) => {
    if (map.has(path) && map.get(path) !== hash) throw new Error(`Input changed while checking: ${path}`);
    map.set(path, hash);
  };
  const readBytes = (path, { allowMissing = false } = {}) => {
    let value;
    try { value = readFileSync(safePath(found.root, path)); }
    catch (error) { if (!allowMissing || error.code !== "ENOENT") throw error; value = null; }
    const hash = value === null ? null : digest(value);
    remember(inputs, path, hash);
    return value;
  };
  const readCompilerInput = (path, { allowMissing = false } = {}) => {
    path = normalize(path); let bytes;
    try {
      const target = safePath(found.root, path, { allowMissing, allowDependencies: true }), stat = lstatSync(target);
      if (stat.isDirectory() && allowMissing) bytes = null;
      else { if (!stat.isFile()) throw new Error(`Compiler inputs must be regular files: ${path}`); bytes = readFileSync(target); }
    } catch (error) { if (!allowMissing || !["ENOENT", "ENOTDIR"].includes(error.code)) throw error; bytes = null; }
    remember(compilerInputs, path, bytes === null ? null : digest(bytes));
    return bytes?.toString("utf8") ?? null;
  };
  const readCompilerDirectory = (path, { allowMissing = false } = {}) => {
    path = normalize(path); let entries;
    try {
      const target = safePath(found.root, path, { allowMissing, allowDependencies: true });
      entries = readdirSync(target, { withFileTypes: true }).map((item) => ({ name: item.name, kind: item.isFile() ? "file" : item.isDirectory() ? "directory" : item.isSymbolicLink() ? "symlink" : "other" })).sort((a, b) => compare(a.name, b.name));
    } catch (error) { if (!allowMissing || !["ENOENT", "ENOTDIR"].includes(error.code)) throw error; entries = null; }
    remember(compilerDirectories, path, entries === null ? null : digest(canonical(entries)));
    return entries;
  };
  return {
    ...found, ...loaded, origins, policySources, allFiles, files, ownedFiles, inputs, compilerInputs, compilerDirectories, registry, protectedFiles,
    readBytes, readCompilerInput, readCompilerDirectory,
    read: (path, options) => readBytes(path, options)?.toString("utf8") ?? null,
    safePath: (path, options) => safePath(found.root, path, options), matches: globMatches,
    writableFiles: files.filter((path) => !protectedFiles.includes(path) && !isPolicyFile(loaded.config, path, configFile)),
    mode: options.mode ?? "check", configFile,
  };
}

export async function javascriptPack() {
  const require = createRequire(import.meta.url);
  let url;
  try { url = pathToFileURL(require.resolve("@ozlabs/plumb-javascript")).href; }
  catch {
    const local = join(packageRoot, "packages/javascript/index.mjs");
    if (existsSync(local)) url = pathToFileURL(local).href;
    else {
      try { url = pathToFileURL(createRequire(join(dirname(process.execPath), "plumb-runtime.cjs")).resolve("@ozlabs/plumb-javascript")).href; }
      catch { throw new Error(`Install @ozlabs/plumb-javascript beside the Plumb checker.`); }
    }
  }
  try {
    const root = dirname(fileURLToPath(url)), manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (manifest.name !== "@ozlabs/plumb-javascript") throw new Error("The JavaScript pack must be @ozlabs/plumb-javascript");
    const identity = { sha256: sourceHash(root) };
    return { ...await import(url), identity };
  }
  catch (error) { throw new Error(`JavaScript pack could not load: ${error.message}. Install its pinned dependencies.`); }
}

function sourceHash(base, folders = ["."]) {
  const entries = [];
  const walk = (root) => {
    if (!existsSync(root)) return;
    for (const file of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (["node_modules", "test"].includes(file.name)) continue;
      const path = join(root, file.name);
      if (file.isDirectory()) walk(path);
      else if (/\.(?:mjs|ts|json|yml)$/.test(file.name) && !file.name.includes(".test.")) entries.push([relative(base, path).replaceAll("\\", "/"), digest(readFileSync(path))]);
    }
  };
  for (const folder of folders) walk(join(base, folder));
  if (!folders.includes(".")) entries.push(["package.json", digest(readFileSync(join(base, "package.json")))]);
  return digest(canonical(entries.sort(([a], [b]) => compare(a, b))));
}

export function checkerIdentity(javascript) {
  return { sha256: globalThis.__PLUMB_BUILD_ID__ ?? sourceHash(packageRoot, ["bin", "src"]), ...(javascript ? { javascript } : {}) };
}

export function report(diagnostics, extra = {}) {
  const normalized = sortDiagnostics(diagnostics.map((item) => ({ ...item, status: item.status ?? "violation", path: normalize(item.path ?? ".") })));
  const status = normalized.some((item) => item.status === "incomplete") ? "incomplete" : normalized.length ? "violation" : "pass";
  return { ...extra, schemaVersion: 1, status, exitCode: status === "incomplete" ? 2 : status === "violation" ? 1 : 0, diagnostics: enrichDiagnostics(normalized) };
}

const statusOf = (items) => items.some((item) => item.status === "incomplete") ? "incomplete" : items.length ? "violation" : "pass";
const governedComments = (ctx) => ctx.files.filter((file) => {
  const language = comments.commentsLanguageOf(file);
  return language && (ctx.config.preset === "ozlabs" || ctx.config.projects.some((project) => project.profile === language && ["ruby", "cpp"].includes(language) && isWithin(project.root, file)));
});

export function executionPlan(ctx, options = {}) {
  const languages = adapters.planAdapters(ctx, { registry: ctx.registry });
  const roles = conventions.planConventions(ctx);
  const core = [
    { id: "files", adapter: "core", root: ".", capability: "files", files: [...new Set([...ctx.files, ...(ctx.config.files?.required ?? [])])].sort(), evidence: "inventory" },
    { id: "generated", adapter: "core", root: ".", capability: "generated", files: ctx.ownedFiles, evidence: "content-and-mode" },
    { id: "comments", adapter: "core", root: ".", capability: "comments", files: governedComments(ctx), evidence: "source-scanner" },
  ];
  if (ctx.config.conventions) core.push({ id: "conventions", adapter: "core", root: ".", capability: "conventions", files: roles.files.filter((file) => !file.excluded).map((file) => file.path), evidence: "role-inventory" });
  const suites = (ctx.config.verification ?? []).map((suite) => ({ id: `test:${suite.id}`, adapter: "verification", root: suite.cwd ?? ".", capability: "tests", files: ctx.files.filter((file) => isWithin(suite.cwd ?? ".", file)), evidence: "test-report", suite: suite.id }));
  const examples = options[FIXTURE_RUN] ? [] : (ctx.config.policyTests ?? []).map((group) => ({ id: `policy-test:${group.id}`, adapter: "core", root: ".", capability: "policy-tests", files: [], evidence: "actual-checker-fixtures", cases: group.cases.map(({ id, expect }) => ({ id, expect })) }));
  const checks = [...core, ...languages.checks, ...suites, ...examples];
  const files = languages.files.map((file) => { const role = roles.files.find((entry) => entry.path === file.path); return { ...file, ...(role ? { roles: role.roles, ...(role.role ? { role: role.role } : {}) } : {}), checks: checks.filter((check) => check.files.includes(file.path)).map((check) => check.id), policyOrigins: ctx.origins["/projects"] ?? ctx.origins[""] ?? [] }; });
  return { schemaVersion: 1, complete: false, checks, files, diagnostics: [...ctx.problems, ...languages.diagnostics, ...roles.diagnostics], adapterPlan: languages, conventions: roles };
}

function validateInputs(ctx, before, options) {
  const diagnostics = [];
  try {
    const after = inventory(ctx.root); diagnostics.push(...after.problems);
    const afterFiles = [...new Set([...after.files, ...ctx.allFiles])].sort();
    if (snapshot(ctx.root, afterFiles) !== before) throw new Error("Repository files changed while checking");
    for (const input of ctx.policyInputs) if (digest(readFileSync(input.path)) !== input.sha256) throw new Error(`Loaded policy input changed: ${input.path}`);
    for (const path of ctx.inputs.keys()) ctx.read(path, { allowMissing: true });
    for (const path of ctx.compilerInputs.keys()) ctx.readCompilerInput(path, { allowMissing: true });
    for (const path of ctx.compilerDirectories.keys()) ctx.readCompilerDirectory(path, { allowMissing: true });
    options.subjectContext?.verify?.(); options.inputBundle?.verify(); options.inputOverlay?.verify?.(); options.workspace?.verify?.();
  } catch (error) { diagnostics.push(failure("run.mutated", ".", error.message)); }
  return diagnostics;
}

function reconcile(checks, before, after, suppressed) {
  for (const check of checks) {
    const original = before.filter((item) => item.check === check.id);
    if (!original.length) continue;
    const visible = after.filter((item) => item.check === check.id);
    check.status = statusOf(visible);
    const count = suppressed.filter((item) => item.check === check.id).length;
    if (count) check.suppressed = count;
  }
}

async function checkContext(options) {
  let ctx;
  try { ctx = context(options); }
  catch (error) { return report([failure("config.invalid", options.configFile ?? "plumb.json", error.message)]); }
  let before;
  try { before = snapshot(ctx.root, ctx.allFiles); }
  catch (error) { return report([failure("inventory.unsafe", ".", error.message)]); }
  let memo;
  try { memo = prepareCache(ctx, options, checkerIdentity()); }
  catch (error) { return report([failure(error.code === "PLUMB_CACHE_MUTATED" ? "run.mutated" : "config.invalid", ".", error.message)]); }
  if (memo?.result) return { ...memo.result, cache: memo.info };
  const subject = options.subjectContext?.subject ?? { kind: "worktree", snapshot: before };
  const plan = executionPlan(ctx, options), checks = [], coverage = [];
  let diagnostics = [...ctx.problems], metadata = coreRules();
  const tools = process.versions.bun ? { bun: process.versions.bun } : { node: process.versions.node };
  const execute = async (id, action, applicable = true) => {
    const planned = plan.checks.find((check) => check.id === id);
    if (!applicable) { checks.push({ id, capability: planned.capability, status: "not-applicable" }); coverage.push({ ...planned, checkedFiles: [], status: "not-applicable", completed: false, reason: "No configured scope for this check." }); return; }
    let found;
    try { found = (await action()).map((item) => ({ ...item, check: item.check ?? id })); }
    catch (error) { found = [{ ...failure("run.failed", ".", `${id}: ${error.message}`), check: id }]; }
    diagnostics.push(...found);
    const status = statusOf(found); checks.push({ id, capability: planned.capability, status });
    coverage.push({ ...planned, checkedFiles: status === "incomplete" ? [] : planned.files, status, completed: status !== "incomplete" });
  };
  await execute("files", () => contracts.checkFiles(ctx));
  if (ctx.config.conventions) await execute("conventions", () => conventions.checkConventions(ctx, plan.conventions));
  await execute("generated", () => assets.checkAssets(ctx), ctx.ownedFiles.length > 0);
  await execute("comments", () => comments.checkComments(ctx), governedComments(ctx).length > 0);
  let language = { diagnostics: [], checks: [], coverage: [], versions: {}, rules: [], identity: {} };
  try { language = await adapters.runAdapters(ctx, plan.adapterPlan, { registry: ctx.registry, loadJavascript: options.loadJavascript ?? javascriptPack, execute: options.execute }); }
  catch (error) { language.diagnostics.push(failure("run.failed", ".", `adapters: ${error.message}`)); }
  diagnostics.push(...language.diagnostics); metadata.push(...language.rules); checks.push(...language.checks); coverage.push(...language.coverage); Object.assign(tools, language.versions);
  if (!adapters.needsJavascript(ctx.config)) checks.push({ id: "javascript", status: "not-applicable" });
  if (!ctx.config.projects.some((project) => ["ruby", "cpp"].includes(project.profile))) checks.push({ id: "native", status: "not-applicable" });
  const behavioral = await verification.verifySuites(ctx, { subject, inputs: options.inputBundle, execute: options.execute, temporaryRoot: options.temporaryRoot });
  diagnostics.push(...behavioral.diagnostics); checks.push(...behavioral.checks);
  for (const check of behavioral.checks) { const planned = plan.checks.find((entry) => entry.id === check.id); coverage.push({ ...planned, checkedFiles: check.status === "incomplete" ? [] : planned.files, status: check.status, completed: check.status !== "incomplete" }); }
  const examples = options[FIXTURE_RUN] ? { diagnostics: [], checks: [], results: [] } : await policyTests.runPolicyTests(ctx, (fixture) => checkContext({ ...fixture, originalRoot: options.originalRoot ?? ctx.root, registry: ctx.registry, loadJavascript: options.loadJavascript, execute: options.execute, date: options.date, temporaryRoot: options.temporaryRoot, [FIXTURE_RUN]: true }), { inputs: options.inputBundle, temporaryRoot: options.temporaryRoot });
  diagnostics.push(...examples.diagnostics); checks.push(...examples.checks);
  for (const check of examples.checks) coverage.push({ ...plan.checks.find((entry) => entry.id === check.id), checkedFiles: [], status: check.status, completed: check.status !== "incomplete" });
  for (const [tool, expected] of Object.entries(ctx.config.tools?.versions ?? {})) {
    if (tools[tool] !== undefined) {
      const actual = tools[tool].match(/\b\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?\b/i)?.[0] ?? tools[tool];
      if (actual !== expected) diagnostics.push(failure("tools.version", ".", `${tool} is ${actual}; policy requires ${expected}.`, "Install the exact approved tool version."));
    } else diagnostics.push(failure("tools.version", ".", `No version was verified for configured tool ${tool}.`, "Correct the tool name or enable its required check; a version pin cannot be silently ignored."));
  }
  diagnostics.push(...validateInputs(ctx, before, options));
  diagnostics = enrichDiagnostics(sortDiagnostics([...new Map(diagnostics.map((item) => [canonical(item), item])).values()]));
  const applied = applyExceptions(diagnostics, ctx.config.exceptions, metadata, options.date);
  reconcile(checks, diagnostics, applied.diagnostics, applied.suppressed);
  let task;
  if (options.loadedTask) {
    task = tasks.checkTask(options.loadedTask, { checks, testResults: behavioral.results, subject });
    applied.diagnostics.push(...task.diagnostics);
    checks.push({ id: "task", capability: "task", status: statusOf(task.diagnostics) });
  }
  for (const row of coverage) { const check = checks.find((entry) => entry.id === row.id); if (check) { row.status = check.status; row.completed = ["pass", "violation"].includes(check.status); if (check.suppressed) row.suppressed = check.suppressed; } }
  const result = report(attachOrigins(applied.diagnostics, ctx.origins), {
    command: options[FIXTURE_RUN] ? "policy-fixture" : "check",
    identity: { snapshot: before, subject, inputs: digest(canonical([...ctx.inputs].sort(([a], [b]) => compare(a, b)))), ...(ctx.compilerInputs.size || ctx.compilerDirectories.size ? { compilerInputs: digest(canonical({ files: [...ctx.compilerInputs].sort(([a], [b]) => compare(a, b)), directories: [...ctx.compilerDirectories].sort(([a], [b]) => compare(a, b)) })) } : {}), policy: digest(canonical(ctx.config)), policySources: ctx.policySources, checker: checkerIdentity(language.identity.javascript), adapters: language.identity, tools, ...(options.loadedTask ? { task: options.loadedTask.identity } : {}), ...(options.inputBundle ? { approvedInputs: options.inputBundle.identity } : {}), ...(ctx.config.exceptions.some((entry) => entry.expires) ? { date: options.date ?? new Date().toISOString().slice(0, 10) } : {}) },
    checks, coverage, ...(language.typedCoverage?.length ? { typedCoverage: language.typedCoverage } : {}), files: plan.files, tests: behavioral.results, ...(examples.results.length ? { policyTests: examples.results } : {}), ...(task ? { task: task.requirements } : {}), suppressed: enrichDiagnostics(sortDiagnostics(attachOrigins(applied.suppressed, ctx.origins))),
  });
  if (memo) {
    try { memo.verify?.(); }
    catch (error) { return report([...result.diagnostics, failure("run.mutated", ".", error.message)], { ...result, cache: { ...memo.info, hit: false } }); }
    try { memo.save?.(result); }
    catch (error) {
      if (error.code === "PLUMB_CACHE_MUTATED") return report([...result.diagnostics, failure("run.mutated", ".", error.message)], { ...result, cache: { ...memo.info, hit: false } });
      memo.info.reason = `Cache was not saved: ${error.message}`;
    }
    try { memo.verify?.(); }
    catch (error) { return report([...result.diagnostics, failure("run.mutated", ".", error.message)], { ...result, cache: { ...memo.info, hit: false } }); }
    result.cache = memo.info;
  }
  return result;
}

export async function testPolicy(options = {}) {
  let ctx;
  try { ctx = context(options); }
  catch (error) { return report([failure("config.invalid", options.configFile ?? "plumb.json", error.message)]); }
  if (!ctx.config.policyTests?.length) return report([failure("policy-tests.incomplete", ctx.configFile, "No policy acceptance fixtures are configured")], { command: "policy-test" });
  const before = snapshot(ctx.root, ctx.allFiles);
  const inputBundle = options.inputManifest ? loadInputs(options.inputManifest, ctx.root) : undefined;
  const examples = await policyTests.runPolicyTests(ctx, (fixture) => checkContext({ ...fixture, originalRoot: ctx.root, registry: ctx.registry, loadJavascript: options.loadJavascript, execute: options.execute, date: options.date, temporaryRoot: options.temporaryRoot, [FIXTURE_RUN]: true }), { inputs: inputBundle, temporaryRoot: options.temporaryRoot });
  return report([...ctx.problems, ...examples.diagnostics, ...validateInputs(ctx, before, { inputBundle })], { command: "policy-test", checks: examples.checks, policyTests: examples.results, identity: { policy: digest(canonical(ctx.config)), checker: checkerIdentity() } });
}

export async function scaffoldRepository(options = {}) {
  try {
    const ctx = context(options), checker = checkerIdentity();
    const inputs = options.inputManifest ? loadInputs(options.inputManifest, ctx.root) : undefined;
    const result = await scaffold(ctx, (candidate) => checkContext({ ...candidate, originalRoot: ctx.root, registry: ctx.registry, loadJavascript: options.loadJavascript, execute: options.execute, date: options.date, temporaryRoot: options.temporaryRoot }), {
      role: options.role, name: options.name, dryRun: options.dryRun, inputs, checker, temporaryRoot: options.temporaryRoot,
      verify: () => { if (canonical(checkerIdentity()) !== canonical(checker)) throw new Error("The scaffold checker changed during validation"); },
    });
    const checked = result.written.length ? await checkRepository(options) : result.checked;
    return report(checked.diagnostics, { command: "scaffold", dryRun: !!options.dryRun, plan: result.plan, written: result.written, checks: checked.checks, ...(result.written.length ? { identity: checked.identity } : {}), next: result.written.length ? "Review the new source and companion files." : result.checked.status === "pass" ? "Run scaffold without --dry-run to validate and create these files." : "Resolve the reported convention or prerequisite failures before creating these files." });
  } catch (error) { return report([failure("run.failed", ".", `Scaffold: ${error.message}`)], { command: "scaffold", written: [] }); }
}

export async function checkRepository(options = {}) {
  let workspace, inputOverlay;
  const originalRoot = resolve(options.root ?? process.cwd());
  try {
    const loadedTask = options.loadedTask ?? (options.task ? tasks.loadTask(options.task, { root: originalRoot }) : undefined);
    const inputBundle = options.inputBundle ?? (options.inputManifest ? loadInputs(options.inputManifest, originalRoot) : undefined);
    const registry = options.registry ?? adapters.loadAdapterRegistry(options.adapters, originalRoot);
    let subjectContext;
    if (inputBundle) {
      const original = context({ ...options, root: originalRoot, registry });
      workspace = copyWorkspace(originalRoot, { files: original.allFiles, temporaryRoot: options.temporaryRoot });
      subjectContext = { subject: { kind: "worktree", snapshot: workspace.identity.snapshot }, verify: workspace.verify };
      inputOverlay = materializeInputs(workspace.root, inputBundle);
    }
    const result = await checkContext({ ...options, root: workspace?.root ?? originalRoot, originalRoot, registry, loadedTask, inputBundle, inputOverlay, subjectContext, workspace });
    return result;
  } catch (error) { return report([failure("run.subject", ".", error.message)]); }
  finally { workspace?.cleanup(); }
}

export async function inspect(options = {}) {
  const ctx = context(options), metadata = coreRules();
  let javascriptIdentity;
  if (adapters.needsJavascript(ctx.config)) { const pack = await (options.loadJavascript ?? javascriptPack)(); metadata.push(...await pack.rules()); javascriptIdentity = pack.identity; }
  if (ctx.registry) metadata.push(...ctx.registry.adapters.flatMap((adapter) => adapter.rules));
  const plan = executionPlan(ctx, options);
  const selected = options.file ? normalize(options.file) : undefined;
  if (selected) ctx.safePath(selected, { allowMissing: true });
  return { schemaVersion: 1, policy: ctx.config, policyHash: digest(canonical(ctx.config)), origins: ctx.origins, policySources: ctx.policySources, files: ctx.files, excludedFiles: ctx.allFiles.filter((file) => !ctx.files.includes(file)), rules: metadata.sort((a, b) => compare(a.id, b.id)), checker: checkerIdentity(javascriptIdentity), plan: { checks: plan.checks, files: plan.files, diagnostics: plan.diagnostics }, ...(selected ? { file: plan.files.find((file) => file.path === selected) ?? { path: selected, present: false, checks: [] } } : {}) };
}

export function planRepository(options = {}) {
  const ctx = context(options);
  const loaded = options.task ? tasks.loadTask(options.task, { root: ctx.root }) : undefined;
  const plan = executionPlan(ctx, options);
  let task;
  if (loaded) {
    task = tasks.taskRequirements(loaded.task);
    for (const name of task.tests) if (!(ctx.config.verification ?? []).some((suite) => suite.id === name)) plan.diagnostics.push(failure("task.tests", ".", `Required suite ${name} is not configured`));
    for (const name of task.checks) if (!plan.checks.some((check) => check.id === name || check.capability === name)) plan.diagnostics.push(failure("task.checks", ".", `Required check ${name} is not configured`));
  }
  return report(plan.diagnostics, { command: "plan", executed: false, complete: false, checks: plan.checks, files: plan.files, origins: ctx.origins, ...(task ? { task } : {}) });
}

export async function doctor(options = {}) {
  let ctx;
  try { ctx = context(options); }
  catch (error) {
    let suggestion;
    try {
      const found = inventory(options.root ?? process.cwd());
      const profiles = [["typescript", /\.[cm]?[jt]sx?$/], ["ruby", /\.(?:rb|rake|gemspec)$|(?:^|\/)(?:Gemfile|Rakefile)$/], ["cpp", /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/], ["python", /\.py$/], ["go", /\.go$/], ["rust", /\.rs$/]];
      suggestion = { schemaVersion: 1, preset: "ozlabs", projects: profiles.filter(([, pattern]) => found.files.some((file) => pattern.test(file))).map(([profile]) => ({ root: ".", profile, ...(profile === "cpp" ? { compileCommands: "build" } : {}) })) };
    } catch {}
    return report([failure("config.invalid", options.configFile ?? "plumb.json", error.message)], { command: "doctor", executed: false, ...(suggestion ? { suggestedPolicy: suggestion, next: "Review this starter policy and install approved adapters for any external profiles before checking." } : {}) });
  }
  let before;
  try { before = snapshot(ctx.root, ctx.allFiles); }
  catch (error) { return report([failure("inventory.unsafe", ".", error.message)], { command: "doctor", executed: false, complete: false }); }
  const prerequisite = await adapters.doctorAdapters(ctx, { registry: ctx.registry, loadJavascript: options.loadJavascript ?? javascriptPack, execute: options.execute });
  const assetProblems = assets.checkAssets(ctx);
  const plan = planRepository(options);
  return report([...prerequisite.diagnostics, ...assetProblems, ...plan.diagnostics, ...validateInputs(ctx, before, options)], { command: "doctor", executed: false, complete: false, checks: prerequisite.checks, plan: { checks: plan.checks, files: prerequisite.plan.files }, tools: prerequisite.versions, identity: prerequisite.identity, suggestions: prerequisite.suggestions, origins: ctx.origins, verification: (ctx.config.verification ?? []).map((suite) => ({ id: suite.id, command: suite.command, format: suite.format, status: "not-run" })) });
}
