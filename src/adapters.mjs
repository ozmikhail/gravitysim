import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { canonical, digest, globMatches, isWithin, normalize } from "./files.mjs";
import { validateSchema } from "./config.mjs";
import { nativeSource, nativeSteps } from "./native.mjs";
import { executeSteps, run } from "./process.mjs";

const text = { type: "string", minLength: 1 };
const name = { ...text, pattern: "^[a-z][a-z0-9-]*$" };
const array = (items, minItems = 0) => ({ type: "array", items, minItems, uniqueItems: true });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const hash = { ...text, pattern: "^[a-f0-9]{64}$" };
const metadata = object({ id: text, description: text, remedy: text, suppressible: { type: "boolean" }, capability: name }, ["id", "description", "remedy"]);
export const registrySchema = object({ schemaVersion: { const: 1 }, adapters: array(object({
  id: name, version: text, files: array({ ...text, format: "glob" }, 1), capabilities: array(name, 1),
  command: array(text, 1), integrity: array(object({ path: text, sha256: hash }, ["path", "sha256"]), 1),
  environment: array({ ...text, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), inputs: array({ ...text, format: "glob" }),
  rules: array(metadata, 1), optionsSchema: { type: "object" }, tools: { type: "object", additionalProperties: text },
}, ["id", "version", "files", "capabilities", "command", "integrity", "rules"])) }, ["schemaVersion", "adapters"]);
export const RULES = [
  ["adapters.registry", "External adapters are explicitly selected, pinned and outside the candidate checkout."],
  ["adapters.protocol", "An adapter returns complete, valid diagnostics and input evidence."],
  ["adapters.coverage", "Every planned file has an explicit completed check or a supported applicability explanation."],
  ["adapters.integrity", "Adapter code and registry files must retain their approved content."],
].map(([id, description]) => ({ id, description, remedy: "Correct the adapter installation or its declared scope, then run the complete check.", suppressible: false }));
const issue = (rule, path, message, check) => ({ rule, path, message, remedy: "Restore the required tool or input and rerun; incomplete coverage cannot be excepted.", status: "incomplete", suppressible: false, ...(check ? { check } : {}) });
const script = (file) => /\.[cm]?[jt]sx?$/.test(file);
const typed = (file) => /\.[cm]?tsx?$/.test(file);
const sort = (items) => [...items].sort();
const same = (left, right) => canonical(sort(left)) === canonical(sort(right));
const withinAbsolute = (root, file) => { const path = relative(root, file); return !path || path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path); };
const statusOf = (diagnostics) => diagnostics.some((item) => item.status === "incomplete") ? "incomplete" : diagnostics.length ? "violation" : "pass";
const registryAdapters = (registry) => registry?.adapters ?? [];
export const profileFamily = (profile) => ["typescript", "react"].includes(profile) ? "javascript" : profile;

function fileHash(path) {
  const value = createHash("sha256"), descriptor = openSync(path, "r"), buffer = Buffer.allocUnsafe(65536);
  try { for (let length; (length = readSync(descriptor, buffer, 0, buffer.length, null));) value.update(buffer.subarray(0, length)); }
  finally { closeSync(descriptor); }
  return value.digest("hex");
}
function checkedSchema(shape) {
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "pattern", "format", "minLength", "minItems", "uniqueItems", "minimum", "maximum"]);
  if (!shape || typeof shape !== "object" || Array.isArray(shape) || Object.keys(shape).some((key) => !allowed.has(key))) throw new Error("Adapter optionsSchema uses unsupported schema keywords");
  if (shape.type && !["object", "array", "string", "boolean", "integer"].includes(shape.type)) throw new Error("Adapter optionsSchema has an unsupported type");
  if (shape.type === "object" && shape.additionalProperties !== false && typeof shape.additionalProperties !== "object") throw new Error("Adapter object schemas must explicitly constrain additionalProperties");
  if (shape.properties) for (const [key, child] of Object.entries(shape.properties)) { if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid adapter schema property"); checkedSchema(child); }
  if (shape.items) checkedSchema(shape.items);
  if (shape.type === "array" && !shape.items) throw new Error("Adapter array schemas require items");
  if (typeof shape.additionalProperties === "object") checkedSchema(shape.additionalProperties);
  if (shape.pattern) new RegExp(shape.pattern);
  if (shape.format && !["path", "glob", "regex"].includes(shape.format)) throw new Error("Adapter schema format is unsupported");
}
function externalFile(path, root) {
  if (!isAbsolute(path)) throw new Error(`Adapter paths must be absolute: ${path}`);
  const actual = realpathSync(path);
  if (withinAbsolute(root, actual)) throw new Error(`Adapter code and registry must be outside the candidate: ${path}`);
  if (!statSync(actual).isFile()) throw new Error(`Adapter input is not a regular file: ${path}`);
  return actual;
}
function commandFiles(entry, root) {
  const pinned = new Set(entry.integrity.map((item) => item.path));
  for (const [index, argument] of entry.command.entries()) {
    if (index === 0) continue;
    if (argument === "-m" || argument.startsWith("--module=") || /^-m[^-]/.test(argument)) throw new Error(`${entry.id}: use a pinned absolute adapter file instead of module-name resolution`);
    if (["-r", "--require", "--import"].includes(argument)) {
      const file = entry.command[index + 1];
      if (!file || !isAbsolute(file) || !pinned.has(file)) throw new Error(`${entry.id}: runtime imports must be absolute pinned files`);
    }
    if (/^--(?:require|import)=/.test(argument) && !pinned.has(argument.slice(argument.indexOf("=") + 1))) throw new Error(`${entry.id}: runtime imports must be absolute pinned files`);
    if (/^-r[^-]/.test(argument) && !pinned.has(argument.slice(2))) throw new Error(`${entry.id}: runtime imports must be absolute pinned files`);
    const value = argument.startsWith("-") && argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : argument;
    if (value.startsWith("-")) continue;
    if (isAbsolute(value)) {
      if (existsSync(value) && statSync(value).isFile() && !pinned.has(value)) throw new Error(`${entry.id}: command file must be pinned: ${value}`);
    } else if (/^(?:\.\.?[\\/])|\.(?:[cm]?[jt]s|py|rb|sh|ps1|exe|wasm)$/i.test(value) || existsSync(resolve(root, value))) throw new Error(`${entry.id}: relative command file is not an approved external entrypoint: ${value}`);
  }
}
export function loadAdapterRegistry(file, candidateRoot) {
  if (!file) return undefined;
  const root = realpathSync(candidateRoot), path = externalFile(resolve(file), root), source = readFileSync(path, "utf8");
  const value = JSON.parse(source); validateSchema(value, registrySchema, "adapters");
  const ids = new Set(["javascript", "typescript", "react", "ruby", "cpp", "native", "core"]), rules = new Set();
  const adapters = value.adapters.map((entry) => {
    if (ids.has(entry.id)) throw new Error(`Duplicate or reserved adapter ${entry.id}`); ids.add(entry.id);
    const pinned = new Map();
    for (const item of entry.integrity) {
      externalFile(item.path, root);
      if (pinned.has(item.path)) throw new Error(`Duplicate integrity input ${item.path}`);
      if (fileHash(item.path) !== item.sha256) throw new Error(`Adapter integrity mismatch: ${item.path}`);
      pinned.set(item.path, item.sha256);
    }
    if (!isAbsolute(entry.command[0]) || !pinned.has(entry.command[0])) throw new Error(`${entry.id}: the executable must be absolute and pinned`);
    commandFiles(entry, root);
    for (const rule of entry.rules) {
      if (!rule.id.startsWith(`${entry.id}/`) || rules.has(rule.id)) throw new Error(`Duplicate or unnamespaced adapter rule ${rule.id}`);
      if (entry.capabilities.length !== 1 && !rule.capability || rule.capability && !entry.capabilities.includes(rule.capability)) throw new Error(`${rule.id}: declare the rule's capability`);
      rules.add(rule.id);
    }
    const optionsSchema = entry.optionsSchema ?? object({}); checkedSchema(optionsSchema);
    return { ...entry, optionsSchema, environment: entry.environment ?? [], inputs: entry.inputs ?? [] };
  });
  return { path, sha256: digest(source), candidateRoot: root, adapters };
}
function verifyRegistry(registry, root) {
  if (!registry) return;
  externalFile(registry.path, realpathSync(root));
  externalFile(registry.path, registry.candidateRoot);
  if (fileHash(registry.path) !== registry.sha256) throw new Error("The adapter registry changed during the run");
  for (const entry of registry.adapters) {
    commandFiles(entry, realpathSync(root)); commandFiles(entry, registry.candidateRoot);
    for (const pin of entry.integrity) {
      externalFile(pin.path, realpathSync(root));
      externalFile(pin.path, registry.candidateRoot);
      if (fileHash(pin.path) !== pin.sha256) throw new Error(`Adapter integrity mismatch: ${pin.path}`);
    }
  }
}
function environment(entry) {
  const values = Object.fromEntries(entry.environment.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return { values, identity: { names: entry.environment, sha256: digest(canonical(entry.environment.map((key) => [key, process.env[key] ?? null]))) } };
}
export function registryIdentity(registry) {
  return registry ? { path: registry.path, sha256: registry.sha256, adapters: registry.adapters.map((entry) => ({ id: entry.id, version: entry.version, integrity: entry.integrity, environment: environment(entry).identity })) } : undefined;
}
export function profileSource(profile, file, root = ".", registry) {
  if (["typescript", "react"].includes(profile)) return script(file);
  if (["ruby", "cpp"].includes(profile)) return nativeSource(profile, file);
  const descriptor = registryAdapters(registry).find((entry) => entry.id === profile);
  const local = root === "." ? file : file.slice(root.length + 1);
  return !!descriptor && globMatches(descriptor.files, local);
}
export function projectFiles(ctx, project, registry) {
  return ctx.files.filter((file) => isWithin(project.root, file) && profileSource(project.profile, file, project.root, registry) && !ctx.config.projects.some((other) => profileFamily(other.profile) === profileFamily(project.profile) && other.root !== project.root && isWithin(project.root, other.root) && isWithin(other.root, file))).sort();
}
export function sourceProfiles(file, registry) {
  const profiles = ["typescript", "react", "ruby", "cpp"].filter((profile) => profileSource(profile, file));
  const parts = file.split("/");
  for (const entry of registryAdapters(registry)) if (parts.some((_part, index) => globMatches(entry.files, parts.slice(index).join("/")))) profiles.push(entry.id);
  return profiles;
}
export const needsJavascript = (config) => config.projects.some((project) => ["typescript", "react"].includes(project.profile)) || Object.values(config.contracts ?? {}).some((items) => items.length) || config.javascript !== undefined || !!config.conventions?.roles.some((role) => role.imports || role.exports || role.javascript);

export function planAdapters(ctx, { registry } = {}) {
  const checks = [], diagnostics = [], known = ["typescript", "react", "ruby", "cpp", ...registryAdapters(registry).map((entry) => entry.id)];
  const selections = new Map(ctx.config.projects.map((project) => [project, projectFiles(ctx, project, registry)]));
  const ownership = new Map([...selections].map(([project, files]) => [project, new Set(files)]));
  const add = (adapter, root, capability, files, evidence, extra = {}) => checks.push({ id: `${adapter}.${capability}:${root}`, adapter, root, capability, files, evidence, ...extra });
  for (const project of ctx.config.projects) {
    if (!known.includes(project.profile)) { diagnostics.push(issue("adapters.registry", project.root, `No approved adapter provides profile ${project.profile}.`)); continue; }
    const selected = selections.get(project), adapter = profileFamily(project.profile);
    try {
      ctx.safePath(project.root);
      if (!selected.length) throw new Error(`No ${project.profile} source files are owned by this project`);
      if (adapter !== "javascript" && !["ruby", "cpp"].includes(adapter)) validateSchema(project.options ?? {}, registry.adapters.find((entry) => entry.id === adapter).optionsSchema, `project ${project.root}.options`);
      else if (project.options && Object.keys(project.options).length) throw new Error("Built-in profiles do not accept external adapter options");
    } catch (error) { diagnostics.push(issue("projects.scope", project.root, error.message)); }
    if (adapter === "javascript") {
      add(adapter, project.root, "lint", selected, "api-reported");
      add(adapter, project.root, "types", selected.filter(typed), "api-reported");
      if (project.knip) for (let i = 1; i <= 3; i++) checks.push({ id: `knip.${project.root}.${i}`, adapter, root: project.root, capability: "dependencies", files: [], evidence: "process-exit", scope: "project" });
    } else if (adapter === "ruby") add(adapter, project.root, "lint", selected, "tool-reported");
    else if (adapter === "cpp") {
      add(adapter, project.root, "format", selected, "explicit-inputs");
      add(adapter, project.root, "lint", selected.filter((file) => !/\.(h|hh|hpp|hxx)$/.test(file)), "explicit-inputs");
    } else for (const capability of registry.adapters.find((entry) => entry.id === adapter).capabilities) add(adapter, project.root, capability, selected, "adapter-reported");
  }
  if (needsJavascript(ctx.config)) {
    add("javascript", ".", "policy", [], "validated-policy", { scope: "policy" });
    add("javascript", ".", "contracts", ctx.files.filter(script), "api-reported", { allowNotApplicable: true });
    if (ctx.config.projects.some((project) => ["typescript", "react"].includes(project.profile))) add("javascript", ".", "format", ctx.files.filter((file) => !ctx.ownedFiles?.includes(file) && !ctx.config.format?.ignore?.some((entry) => ctx.matches(entry.path, file))), "api-reported", { allowNotApplicable: true });
  }
  if (ctx.config.preset === "ozlabs") for (const file of ctx.files) {
    if (sourceProfiles(file, registry).length && !ctx.config.projects.some((project) => ownership.get(project).has(file))) diagnostics.push(issue("projects.uncovered", file, "No configured language profile covers this supported source file."));
  }
  const selected = new Set(ctx.files), assigned = new Map();
  for (const check of checks) for (const path of check.files) { if (!assigned.has(path)) assigned.set(path, []); assigned.get(path).push(check.id); }
  const files = (ctx.allFiles ?? ctx.files).map((path) => ({ path, excluded: !selected.has(path), reasons: ctx.config.exclude?.filter((entry) => globMatches(entry.files, path)).map((entry) => entry.reason) ?? [], owners: ctx.config.projects.filter((project) => ownership.get(project).has(path)).map(({ root, profile }) => ({ root, profile })), checks: assigned.get(path) ?? [] }));
  return { schemaVersion: 1, checks, files, diagnostics, identity: registryIdentity(registry) };
}

export function validateCoverage(planned, returned = []) {
  const diagnostics = [], coverage = [], ids = new Set(planned.map((entry) => entry.id)), seen = new Set();
  if (!Array.isArray(returned)) returned = [];
  for (const row of returned) if (!row || !ids.has(row.id) || seen.has(row.id)) diagnostics.push(issue("adapters.protocol", ".", `Unexpected or duplicate coverage record ${row?.id ?? "(missing id)"}.`)); else seen.add(row.id);
  for (const check of planned) {
    const row = returned.find((entry) => entry?.id === check.id), files = row?.checkedFiles, excluded = row?.notApplicable ?? [];
    let valid = !!row && Array.isArray(files) && new Set(files).size === files.length && files.every((file) => check.files.includes(file)) && Array.isArray(excluded) && excluded.every((entry) => check.allowNotApplicable && typeof entry?.reason === "string" && entry.reason.trim() && check.files.includes(entry.path)) && new Set([...files, ...excluded.map((entry) => entry.path)]).size === files.length + excluded.length && same([...files, ...excluded.map((entry) => entry.path)], check.files);
    valid &&= ["pass", "violation", "incomplete", "not-applicable"].includes(row.status) && (row.status !== "not-applicable" || !files.length && !check.scope && (check.files.length === 0 || excluded.length === check.files.length));
    valid &&= !["pass", "violation"].includes(row.status) || !check.files.length || files.length > 0;
    if (!valid) diagnostics.push(issue("adapters.coverage", check.root, `Check ${check.id} did not account for its complete planned scope.`, check.id));
    coverage.push({ ...check, checkedFiles: valid ? files : [], ...(valid && excluded.length ? { notApplicable: excluded } : {}), status: valid ? row.status : "incomplete", completed: valid && ["pass", "violation"].includes(row.status) });
  }
  return { diagnostics, coverage };
}

function relativeOutput(ctx, cwd, path) {
  if (typeof path !== "string" || !path) throw new Error("Tool diagnostics need a source path");
  const clean = normalize(relative(ctx.root, resolve(cwd, path)).replaceAll("\\", "/"));
  ctx.safePath(clean); return clean;
}
function rubocop(ctx, step, result) {
  const payload = JSON.parse(result.stdout), diagnostics = [], checkedFiles = [];
  if (!Array.isArray(payload.files) || !Number.isInteger(payload.summary?.inspected_file_count) || payload.summary.inspected_file_count !== payload.files.length || payload.errors?.length) throw new Error("RuboCop did not report a complete file inspection");
  for (const file of payload.files) {
    const path = relativeOutput(ctx, step.cwd, file.path); checkedFiles.push(path);
    if (!step.files.includes(path) || !Array.isArray(file.offenses)) throw new Error("RuboCop reported unexpected files or malformed offenses");
    for (const offense of file.offenses) {
      if (typeof offense.message !== "string" || typeof offense.cop_name !== "string") throw new Error("RuboCop returned a malformed offense");
      const line = offense.location?.start_line ?? offense.location?.line, column = offense.location?.start_column ?? offense.location?.column;
      diagnostics.push({ rule: "ruby.lint", path, message: `${offense.cop_name}: ${offense.message}`, remedy: "Resolve the Ruby source diagnostic.", suppressible: false, check: step.id, ...(Number.isInteger(line) && line > 0 ? { line } : {}), ...(Number.isInteger(column) && column > 0 ? { column } : {}) });
    }
  }
  if (!same(checkedFiles, step.files) || new Set(checkedFiles).size !== checkedFiles.length || result.code === 1 && !diagnostics.length) throw new Error("RuboCop's reported coverage or exit status is incomplete");
  return { diagnostics, coverage: { id: step.id, checkedFiles, status: statusOf(diagnostics) } };
}
function launcher(command, root) {
  const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? "").split(delimiter).flatMap((folder) => process.platform === "win32" && !/\.[a-z]+$/i.test(command) ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => join(folder, command + extension)) : [join(folder, command)]);
  for (const path of candidates) {
    try {
      accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      const actual = externalFile(resolve(path), realpathSync(root));
      return { command: resolve(path), path: actual, sha256: fileHash(actual), kind: "launcher" };
    } catch (error) { if (/outside the candidate/.test(error.message)) throw error; }
  }
  throw new Error(`Cannot locate executable ${command}`);
}
async function nativeRun(ctx, project, execute, doctor) {
  const diagnostics = [], coverage = [], versions = {}, identities = [];
  let steps;
  try { steps = nativeSteps({ ...ctx, files: projectFiles(ctx, project), config: { ...ctx.config, projects: [project] } }); }
  catch (error) { return { diagnostics: [issue("native.scope", project.root, error.message)], coverage, versions, identities }; }
  for (const step of steps) {
    try {
      let pinned;
      if (execute === run) {
        const identity = launcher(step.command[0], ctx.root); identities.push({ check: step.id, ...identity });
        pinned = identity; step.command[0] = identity.path; step.versionCommand[0] = identity.path;
      } else identities.push({ check: step.id, source: "injected" });
      if (doctor) {
        const probe = await execute(step.versionCommand, { cwd: step.cwd, timeout: ctx.config.tools?.timeout ?? 120000 });
        if (probe.error || probe.code !== 0) throw new Error(probe.error ?? probe.stderr ?? `Version probe exited ${probe.code}`);
        const version = `${probe.stdout}\n${probe.stderr}`.trim(), actual = version.match(/\b\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?\b/i)?.[0] ?? version;
        if (ctx.config.tools?.versions?.[step.tool] && ctx.config.tools.versions[step.tool] !== actual) throw new Error(`${step.tool} is ${actual}; the policy requires ${ctx.config.tools.versions[step.tool]}`);
        versions[step.tool] ??= version; versions[`${step.tool}@${step.path}`] = version;
        coverage.push({ id: step.id, checkedFiles: [], status: "ready", evidence: "prerequisites-only" });
      } else {
        let actual;
        const result = await executeSteps(ctx, [step], async (command, options) => { const output = await execute(command, options); if (command === step.command) actual = output; return output; });
        Object.assign(versions, result.versions);
        if (actual && !actual.error && [0, 1].includes(actual.code) && project.profile === "ruby") { const parsed = rubocop(ctx, step, actual); diagnostics.push(...parsed.diagnostics); coverage.push(parsed.coverage); }
        else { diagnostics.push(...result.diagnostics.map((item) => ({ ...item, check: step.id }))); coverage.push({ id: step.id, checkedFiles: actual && !actual.error && [0, 1].includes(actual.code) ? step.files : [], status: result.checks[0]?.status ?? "incomplete" }); }
      }
      if (pinned && fileHash(pinned.path) !== pinned.sha256) throw new Error(`Tool launcher changed while checking: ${pinned.path}`);
    } catch (error) { const row = coverage.find((item) => item.id === step.id); if (row) row.status = "incomplete"; diagnostics.push(issue(doctor ? "tools.missing" : "adapters.protocol", project.root, error.message, step.id)); }
  }
  return { diagnostics, coverage, versions, identities };
}

const locationSchema = object({ path: text, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 }, message: text }, ["path"]);
const responseSchema = object({
  schemaVersion: { const: 1 }, adapter: name, version: text, status: { enum: ["pass", "violation", "incomplete"] },
  diagnostics: array(object({ rule: text, path: text, message: text, remedy: text, status: { enum: ["violation", "incomplete"] }, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 }, relatedLocations: array(locationSchema) }, ["rule", "path", "message"])),
  coverage: array(object({ capability: name, files: array(text) }, ["capability", "files"])),
  inputs: array(object({ path: text, sha256: {} }, ["path", "sha256"])),
  versions: { type: "object", additionalProperties: text },
}, ["schemaVersion", "adapter", "version", "status", "diagnostics", "coverage", "inputs"]);
// Input hashes are validated below as SHA-256 or observed absence; the schema vocabulary has no unions.
async function externalRun(ctx, project, entry, registry, execute, doctor) {
  verifyRegistry(registry, ctx.root);
  validateSchema(project.options ?? {}, entry.optionsSchema, `project ${project.root}.options`);
  const selected = projectFiles(ctx, project, registry), inputs = new Map();
  if (!selected.length) throw new Error(`No ${entry.id} source files are owned by this project`);
  const observe = (path) => {
    let value;
    if (ctx.readBytes) value = ctx.readBytes(path, { allowMissing: true });
    else {
      ctx.read?.(path, { allowMissing: true });
      try { value = readFileSync(ctx.safePath(path, { allowMissing: true })); } catch (error) { if (error.code !== "ENOENT") throw error; value = null; }
    }
    const sha256 = value === null ? null : digest(value);
    if (inputs.has(path) && inputs.get(path) !== sha256) throw new Error(`Adapter input changed while checking: ${path}`);
    inputs.set(path, sha256); return { path, sha256 };
  };
  const files = selected.map(observe);
  for (const pattern of entry.inputs) if (!/[?*{}]/.test(pattern) && normalize(pattern) !== "." && !pattern.endsWith("/")) observe(normalize(pattern));
  for (const path of ctx.allFiles ?? ctx.files) if (globMatches(entry.inputs, path)) observe(path);
  const env = environment(entry);
  const request = { schemaVersion: 1, action: doctor ? "doctor" : "check", adapter: entry.id, version: entry.version, root: ctx.root, project, files, inputs: [...inputs].map(([path, sha256]) => ({ path, sha256 })), capabilities: entry.capabilities };
  const result = await execute(entry.command, { cwd: ctx.safePath(project.root), timeout: ctx.config.tools?.timeout ?? 120000, inheritEnv: false, env: env.values, input: JSON.stringify(request) + "\n" });
  verifyRegistry(registry, ctx.root);
  if (result.error || ![0, 1, 2].includes(result.code)) throw new Error(result.error ?? `${entry.id} exited ${result.code}: ${result.stderr}`);
  const response = JSON.parse(result.stdout); validateSchema(response, responseSchema, "adapter response");
  if (response.adapter !== entry.id || response.version !== entry.version || result.code !== { pass: 0, violation: 1, incomplete: 2 }[response.status]) throw new Error("Adapter response identity or exit status does not match its declaration");
  const rules = new Map(entry.rules.map((rule) => [rule.id, rule]));
  const diagnostics = response.diagnostics.map((item) => {
    if (!rules.has(item.rule) || !selected.includes(normalize(item.path)) && !globMatches(entry.inputs, item.path) && !(normalize(item.path) === project.root && item.status === "incomplete")) throw new Error("Adapter reported an unknown rule or a diagnostic outside its selected scope");
    ctx.safePath(item.path, { allowMissing: item.status === "incomplete" });
    for (const related of item.relatedLocations ?? []) { ctx.safePath(related.path); if (!selected.includes(normalize(related.path)) && !globMatches(entry.inputs, related.path)) throw new Error("Adapter related location is outside its declared inputs"); }
    return { ...item, path: normalize(item.path), remedy: item.remedy ?? rules.get(item.rule).remedy, suppressible: item.status !== "incomplete" && rules.get(item.rule).suppressible !== false, check: `${entry.id}.${rules.get(item.rule).capability ?? entry.capabilities[0]}:${project.root}` };
  });
  if (statusOf(diagnostics) !== response.status) throw new Error("Adapter diagnostics contradict its reported status");
  if (!same(Object.keys(response.versions ?? {}), Object.keys(entry.tools ?? {}))) throw new Error("Adapter tool versions do not match its declared tool set");
  for (const [tool, expected] of Object.entries(entry.tools ?? {})) if (response.versions[tool] !== expected) throw new Error(`${tool} is ${response.versions[tool]}; the adapter requires ${expected}`);
  const seen = new Set();
  for (const input of response.inputs) {
    const path = normalize(input.path);
    if (seen.has(path) || !selected.includes(path) && !globMatches(entry.inputs, path) || input.sha256 !== null && (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256))) throw new Error("Adapter reported duplicate, out-of-scope or malformed input evidence");
    seen.add(path);
    if (observe(path).sha256 !== input.sha256) throw new Error(`Adapter read a different input: ${path}`);
  }
  if (!doctor && selected.some((path) => !seen.has(path))) throw new Error("Adapter omitted source input hashes");
  for (const [path, before] of [...inputs]) if (observe(path).sha256 !== before) throw new Error(`Adapter mutated an observed input: ${path}`);
  if (doctor && response.coverage.length) throw new Error("A doctor response cannot claim executed source coverage");
  const coverage = response.coverage.map((row) => { const id = `${entry.id}.${row.capability}:${project.root}`; return { id, checkedFiles: row.files.map(normalize), status: statusOf(diagnostics.filter((item) => item.check === id)) }; });
  return { diagnostics, coverage, versions: { [`adapter/${entry.id}`]: entry.version, ...(response.versions ?? {}), ...Object.fromEntries(Object.entries(response.versions ?? {}).map(([tool, version]) => [`${entry.id}/${tool}@${project.root}`, version])) }, identity: { id: entry.id, version: entry.version, environment: env.identity, integrity: entry.integrity } };
}

export async function runAdapters(ctx, plan, { registry, loadJavascript, execute = run } = {}) {
  const diagnostics = [...plan.diagnostics], coverage = [], typedCoverage = [], checks = [], versions = {}, rules = [...RULES], identity = { registry: registryIdentity(registry), native: [] };
  const mergeVersions = (source) => { for (const [name, value] of Object.entries(source ?? {})) versions[name] ??= value; };
  if (needsJavascript(ctx.config)) {
    try {
      if (!loadJavascript) throw new Error("Install and supply the matching JavaScript adapter");
      const pack = await loadJavascript(); rules.push(...await pack.rules()); identity.javascript = pack.identity ?? { source: "injected" };
      const result = await pack.check(ctx, plan.checks.filter((check) => check.adapter === "javascript")); diagnostics.push(...result.diagnostics); coverage.push(...result.coverage ?? []); mergeVersions(result.versions);
      typedCoverage.push(...result.typedCoverage ?? []);
    } catch (error) { diagnostics.push(issue("tools.missing", ".", error.message)); }
  }
  for (const project of ctx.config.projects) {
    if (["typescript", "react"].includes(project.profile)) continue;
    const expected = plan.checks.filter((check) => check.adapter === project.profile && check.root === project.root);
    if (["ruby", "cpp"].includes(project.profile)) {
      const result = await nativeRun(ctx, project, execute, false);
      diagnostics.push(...result.diagnostics); coverage.push(...result.coverage); mergeVersions(result.versions); identity.native.push(...result.identities);
    } else {
      const entry = registryAdapters(registry).find((adapter) => adapter.id === project.profile);
      if (!entry) continue;
      rules.push(...entry.rules);
      try {
        if (canonical(registryIdentity(registry)) !== canonical(plan.identity)) throw new Error("The adapter environment changed after planning");
        const result = await externalRun(ctx, project, entry, registry, execute, false); diagnostics.push(...result.diagnostics); coverage.push(...result.coverage); mergeVersions(result.versions);
        if (canonical(registryIdentity(registry)) !== canonical(plan.identity)) throw new Error("The adapter environment changed while checking");
      }
      catch (error) { for (const check of expected) { const row = coverage.find((item) => item.id === check.id); if (row) row.status = "incomplete"; } diagnostics.push(issue("adapters.protocol", project.root, error.message)); }
    }
  }
  const outcomes = coverage.map((row) => {
    if (!row || typeof row !== "object") return row;
    if (!["pass", "violation", "incomplete", "not-applicable"].includes(row.status)) return row;
    const found = diagnostics.filter((item) => item.check === row.id);
    if (found.length && (row.status !== "incomplete" || statusOf(found) === "incomplete")) return { ...row, status: statusOf(found) };
    if (["violation", "incomplete"].includes(row.status)) {
      diagnostics.push(issue("adapters.protocol", ".", `Check ${row.id} reported ${row.status} without a matching diagnostic.`, row.id));
      return { ...row, status: "incomplete" };
    }
    return row;
  });
  const validated = validateCoverage(plan.checks, outcomes); diagnostics.push(...validated.diagnostics);
  for (const item of validated.coverage) checks.push({ id: item.id, adapter: item.adapter, root: item.root, capability: item.capability, status: item.status, files: item.checkedFiles, evidence: item.evidence });
  return { diagnostics, checks, coverage: validated.coverage, ...(typedCoverage.length ? { typedCoverage } : {}), versions, rules: [...new Map(rules.map((rule) => [rule.id, rule])).values()], identity };
}

export async function doctorAdapters(ctx, { registry, loadJavascript, execute = run } = {}) {
  const plan = planAdapters(ctx, { registry }), diagnostics = [...plan.diagnostics], versions = {}, identity = { registry: registryIdentity(registry), native: [] }, checks = [];
  if (needsJavascript(ctx.config)) {
    try {
      if (!loadJavascript) throw new Error("Install the matching JavaScript adapter");
      const pack = await loadJavascript(); identity.javascript = pack.identity ?? { source: "injected" };
      if (typeof pack.doctor !== "function") throw new Error("The JavaScript pack does not provide a prerequisite probe");
      const result = await pack.doctor(ctx); diagnostics.push(...result.diagnostics ?? []); Object.assign(versions, result.versions); checks.push({ id: "javascript", status: result.diagnostics?.length ? statusOf(result.diagnostics) : "ready", evidence: "prerequisites-only" });
    } catch (error) { diagnostics.push(issue("tools.missing", ".", error.message)); }
  }
  for (const project of ctx.config.projects) {
    if (["ruby", "cpp"].includes(project.profile)) {
      const result = await nativeRun(ctx, project, execute, true); diagnostics.push(...result.diagnostics); checks.push(...result.coverage); Object.assign(versions, result.versions); identity.native.push(...result.identities);
    } else if (!["typescript", "react"].includes(project.profile)) {
      const entry = registryAdapters(registry).find((adapter) => adapter.id === project.profile); if (!entry) continue;
      try { const result = await externalRun(ctx, project, entry, registry, execute, true); diagnostics.push(...result.diagnostics); Object.assign(versions, result.versions); checks.push({ id: entry.id, root: project.root, status: result.diagnostics.length ? statusOf(result.diagnostics) : "ready", evidence: "prerequisites-only" }); }
      catch (error) { diagnostics.push(issue("adapters.protocol", project.root, error.message)); }
    }
  }
  const suggestions = [];
  for (const [profile, pattern] of [["typescript", /\.[cm]?[jt]sx?$/], ["ruby", /\.(rb|rake|gemspec)$|(?:^|\/)(Gemfile|Rakefile)$/], ["cpp", /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/], ["python", /\.py$/], ["go", /\.go$/], ["rust", /\.rs$/]]) {
    const files = plan.files.filter((file) => !file.excluded && !file.owners.length && pattern.test(file.path)).map((file) => file.path);
    if (files.length) suggestions.push({ project: { root: ".", profile, ...(profile === "cpp" ? { compileCommands: "build" } : {}) }, files, reason: registryAdapters(registry).some((entry) => entry.id === profile) || ["typescript", "ruby", "cpp"].includes(profile) ? "Review a project profile for these unowned source files." : "Install an approved external adapter, then review this project profile." });
  }
  return { diagnostics, checks, versions, identity, plan, suggestions };
}
