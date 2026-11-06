import { lstatSync } from "node:fs";
import { posix } from "node:path";

import { validateSchema } from "./schema.mjs";
import { globMatches, isPolicyFile, normalize, safePath } from "./files.mjs";

const text = { type: "string", minLength: 1 };
const id = { ...text, pattern: "^[a-z][a-z0-9-]*$" };
const bool = { type: "boolean" };
const integer = { type: "integer", minimum: 0 };
const path = { ...text, format: "path" };
const regex = { ...text, format: "regex" };
const array = (items, minItems = 0) => ({ type: "array", items, minItems, uniqueItems: true });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const globs = (minimum = 1) => array({ ...text, format: "glob" }, minimum);
const names = (minimum = 0) => array(text, minimum);
const template = object({ path, content: { type: "string" } }, ["path", "content"]);
const kinds = ["function", "class", "interface", "type", "variable", "method", "property", "constructor"];

export const CONVENTIONS_SCHEMA = object({
  files: globs(),
  roles: array(object({
    id, files: globs(), name: regex,
    imports: object({ allow: globs(0), deny: globs(0) }),
    exports: object({ require: names(), allow: names(), name: regex }),
    companions: array(object({ path, role: id }, ["path"]), 1),
    javascript: object({
      nodes: array(object({
        id, select: object({ kinds: array({ enum: kinds }, 1), names: names(1), exported: bool, topLevel: bool }, ["kinds"]),
        count: object({ min: integer, max: integer }),
      }, ["id", "select", "count"]), 1),
      assignable: array(object({ id, export: text, contract: object({ file: path, symbol: text }, ["file", "symbol"]), tsconfig: path }, ["id", "export", "contract", "tsconfig"]), 1),
      budgets: object({
        functionLines: { ...integer, minimum: 1 }, maxParameters: integer, maxNesting: integer,
        duplicateBlocks: object({ minStatements: { ...integer, minimum: 2 }, maxCopies: { ...integer, minimum: 1 } }, ["minStatements", "maxCopies"]),
      }),
    }),
    scaffold: object({ ...template.properties, companions: array(template, 1) }, template.required),
  }, ["id", "files"]), 1),
}, ["files", "roles"]);

export const RULES = [
  ["conventions.scope", "Every declared convention scope contains readable selected inputs.", false],
  ["conventions.role", "Every governed source has exactly one architectural role.", false],
  ["conventions.name", "Role filenames follow their declared naming pattern.", true],
  ["conventions.companion", "Role files have their required selected companion files.", true],
].map(([id, description, suppressible]) => ({ id, description, suppressible, remedy: "Correct the source layout to satisfy its declared role; review policy changes separately." }));

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const unique = (values) => [...new Set(values)].sort(compare);
const issue = (rule, path, message, incomplete = false) => ({
  rule, path, message, remedy: "Restore the required source or correct its declared role and scope.",
  status: incomplete ? "incomplete" : "violation", suppressible: !incomplete && ["conventions.name", "conventions.companion"].includes(rule),
});
const fail = (message) => { throw new TypeError(`conventions: ${message}`); };
const substitutes = ["name", "dir", "stem", "ext"];
const valuesFor = (path, name) => {
  const ext = posix.extname(path), stem = posix.basename(path, ext);
  return { name: name ?? stem, dir: posix.dirname(path), stem, ext };
};

function expand(value, values, isPath = false) {
  const rendered = value.replace(/\{(name|dir|stem|ext)\}/g, (_match, name) => {
    if (!Object.hasOwn(values, name)) fail(`unsupported template substitution {${name}}`);
    return values[name];
  });
  if (!isPath) return rendered;
  if (/[?*{}]/.test(rendered)) fail("template paths must resolve to literal paths without unknown substitutions");
  validateSchema(rendered, path, "conventions template path");
  const target = normalize(rendered);
  if (target === "." || target.length > 4096) fail("template target must be a bounded file path");
  return target;
}

function validateTemplate(entry, variables) {
  if (entry.path.length > 1024 || (entry.content?.length ?? 0) > 65536) fail("templates are limited to 1024 path characters and 64 KiB of content");
  const values = Object.fromEntries(variables.map((name) => [name, name === "dir" ? "src" : name === "ext" ? ".ts" : "example"]));
  expand(entry.path, values, true);
  if (entry.content !== undefined) expand(entry.content, values);
}

// The same definition drives runtime validation, generated JSON Schema and scaffolding.
export function validateConventions(value) {
  if (value === undefined) return value;
  validateSchema(value, CONVENTIONS_SCHEMA, "conventions");
  if (value.roles.length > 256) fail("at most 256 roles may be declared");
  const ids = new Set();
  for (const role of value.roles) {
    if (ids.has(role.id)) fail(`duplicate role ${role.id}`);
    ids.add(role.id);
    if (role.imports && role.imports.allow === undefined && !role.imports.deny?.length) fail(`${role.id}: imports must constrain allow or deny`);
    if (role.exports && role.exports.allow === undefined && !role.exports.require?.length && !role.exports.name) fail(`${role.id}: exports must constrain names`);
    if (role.exports?.require?.some((name) => role.exports.allow && !role.exports.allow.includes(name) || role.exports.name && !new RegExp(role.exports.name).test(name))) fail(`${role.id}: required exports conflict with allowed names`);
    if (role.javascript && !Object.keys(role.javascript).length) fail(`${role.id}: javascript cannot be empty`);
    if (role.javascript?.budgets && !Object.keys(role.javascript.budgets).length) fail(`${role.id}: budgets cannot be empty`);
    const assertions = new Set();
    for (const assertion of [...role.javascript?.nodes ?? [], ...role.javascript?.assignable ?? []]) {
      if (assertions.has(assertion.id)) fail(`${role.id}: duplicate assertion ${assertion.id}`);
      assertions.add(assertion.id);
      if (assertion.count && (!(assertion.count.min > 0) && assertion.count.max === undefined || (assertion.count.min ?? 0) > (assertion.count.max ?? Infinity))) fail(`${role.id}/${assertion.id}: count must define a meaningful, ordered minimum or maximum`);
    }
    for (const companion of role.companions ?? []) validateTemplate(companion, substitutes);
    if (role.scaffold) {
      validateTemplate(role.scaffold, ["name"]);
      if ((role.scaffold.companions?.length ?? 0) > 63) fail("a scaffold can create at most 64 source files");
      for (const companion of role.scaffold.companions ?? []) validateTemplate(companion, substitutes);
    }
  }
  for (const role of value.roles) for (const companion of role.companions ?? []) {
    if (companion.role && !ids.has(companion.role)) fail(`${role.id}: unknown companion role ${companion.role}`);
  }
  return value;
}

export function planConventions(ctx) {
  const value = ctx.config.conventions;
  const plan = { files: [], roles: [], diagnostics: [] };
  if (!value) return plan;
  try { validateConventions(value); }
  catch (error) { plan.diagnostics.push(issue("conventions.scope", ctx.configFile ?? "plumb.json", error.message, true)); return plan; }
  const reasons = (path) => (ctx.config.exclude ?? []).filter((entry) => globMatches(entry.files, path)).map((entry) => entry.reason);
  const selected = new Set(ctx.files.filter((path) => !reasons(path).length).map(normalize));
  const governed = unique([...(ctx.allFiles ?? ctx.files), ...ctx.files].map(normalize)).filter((path) => globMatches(value.files, path));
  const files = governed.filter((path) => selected.has(path));
  const scope = (patterns, label) => {
    for (const pattern of patterns) if (!files.some((path) => globMatches(pattern, path))) plan.diagnostics.push(issue("conventions.scope", ctx.configFile ?? "plumb.json", `${label}: no selected governed files match ${pattern}.`, true));
  };
  scope(value.files, "Governed source");
  for (const role of value.roles) scope(role.files, `Role ${role.id}`);
  for (const path of governed) {
    const roles = value.roles.filter((role) => globMatches(role.files, path)).map((role) => role.id).sort(compare);
    const excluded = !selected.has(path), why = reasons(path);
    plan.files.push({ path, roles, ...(roles.length === 1 && { role: roles[0] }), excluded, reasons: why });
    if (excluded) {
      if (!why.length) plan.diagnostics.push(issue("conventions.scope", path, "Governed source is absent from the selected inventory without a declared exclusion.", true));
    } else if (roles.length !== 1) plan.diagnostics.push(issue("conventions.role", path, roles.length ? `Source matches multiple roles: ${roles.join(", ")}.` : "Source has no declared architectural role."));
  }
  plan.roles = value.roles.map(({ id }) => ({ id, files: plan.files.filter((file) => !file.excluded && file.role === id).map((file) => file.path) }));
  return plan;
}

const guarded = (ctx, path, options) => ctx.safePath ? ctx.safePath(path, options) : safePath(ctx.root, path, options);
const regular = (ctx, path) => {
  if (!lstatSync(guarded(ctx, path)).isFile()) throw new Error("The selected input is not a regular file");
};

export function checkConventions(ctx, plan = planConventions(ctx)) {
  const diagnostics = [...plan.diagnostics];
  if (!ctx.config.conventions || diagnostics.some((item) => item.status === "incomplete")) return diagnostics;
  const selected = new Set(ctx.files.filter((path) => !(ctx.config.exclude ?? []).some((entry) => globMatches(entry.files, path))));
  const roles = new Map(ctx.config.conventions.roles.map((role) => [role.id, role]));
  for (const file of plan.files.filter((file) => !file.excluded && file.role)) {
    const role = roles.get(file.role);
    try { regular(ctx, file.path); }
    catch (error) { diagnostics.push(issue("conventions.scope", file.path, error.message, true)); continue; }
    if (role.name && !new RegExp(role.name).test(posix.basename(file.path))) diagnostics.push(issue("conventions.name", file.path, `Role ${role.id} requires a filename matching ${role.name}.`));
    for (const companion of role.companions ?? []) {
      let target;
      try {
        target = expand(companion.path, valuesFor(file.path), true);
        if (target === file.path) throw new Error("A required companion must be a different file");
        regular(ctx, target);
        if (!selected.has(target)) throw new Error(`Companion ${target} is outside the selected inventory`);
        if (companion.role && plan.files.find((item) => item.path === target && !item.excluded)?.role !== companion.role) diagnostics.push(issue("conventions.companion", file.path, `Companion ${target} must have role ${companion.role}.`));
      } catch (error) {
        diagnostics.push(issue("conventions.companion", file.path, `Role ${role.id} needs companion ${target ?? companion.path}: ${error.message}`, error.code !== "ENOENT"));
      }
    }
  }
  return diagnostics;
}

// Proposals are literal data. The caller checks an isolated candidate before transactional creation.
export function scaffoldProposals(ctx, { role: roleId, name }) {
  const value = validateConventions(ctx.config.conventions);
  const role = value?.roles.find((entry) => entry.id === roleId);
  if (!role?.scaffold) fail(`role ${roleId} has no scaffold`);
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) fail("scaffold name must be one identifier-like path segment of at most 64 characters");
  const first = { path: expand(role.scaffold.path, { name }, true), content: expand(role.scaffold.content, { name }) };
  const values = valuesFor(first.path, name);
  const proposals = [first, ...(role.scaffold.companions ?? []).map((entry) => ({ path: expand(entry.path, values, true), content: expand(entry.content, values) }))];
  const seen = new Set(), existing = new Set((ctx.allFiles ?? ctx.files).map((path) => normalize(path).toLowerCase()));
  for (const proposal of proposals) {
    const key = proposal.path.toLowerCase();
    if (seen.has(key)) fail(`duplicate scaffold target ${proposal.path}`);
    seen.add(key);
    const absolute = guarded(ctx, proposal.path, { allowMissing: true });
    try { lstatSync(absolute); fail(`scaffold cannot overwrite ${proposal.path}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing.has(key)) fail(`scaffold target conflicts with an existing input: ${proposal.path}`);
    if (isPolicyFile(ctx.config, proposal.path, ctx.configFile) || proposal.path.endsWith(".surface.json") || [...ctx.ownedFiles ?? [], ...ctx.protectedFiles ?? [], ...(ctx.config.generated ?? []).map((entry) => entry.path)].includes(proposal.path)) fail(`scaffold cannot create protected policy, generated or API input ${proposal.path}`);
    if ((ctx.config.exclude ?? []).some((entry) => globMatches(entry.files, proposal.path)) || !globMatches(value.files, proposal.path)) fail(`scaffold target ${proposal.path} is outside the governed source scope`);
    const matches = value.roles.filter((entry) => globMatches(entry.files, proposal.path));
    if (matches.length !== 1 || proposal === first && matches[0].id !== role.id) fail(`scaffold target ${proposal.path} must have exactly its intended role`);
    proposal.role = matches[0].id;
    if (matches[0].name && !new RegExp(matches[0].name).test(posix.basename(proposal.path))) fail(`scaffold target ${proposal.path} violates role ${proposal.role}'s filename pattern`);
  }
  return proposals.sort((left, right) => compare(left.path, right.path));
}
