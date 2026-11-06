import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalize, safePath } from "./files.mjs";
import { validateSchema } from "./schema.mjs";
export { validateSchema } from "./schema.mjs";
import { BUNDLE_REFERENCE_SCHEMA, resolvePolicy } from "./bundles.mjs";
import { POLICY_TESTS_SCHEMA, validatePolicyTests } from "./policy-tests.mjs";
import { CONVENTIONS_SCHEMA, validateConventions } from "./conventions.mjs";

const text = { type: "string", minLength: 1 };
const reason = { ...text, pattern: "\\S" };
const bool = { type: "boolean" };
const integer = { type: "integer", minimum: 1 };
const array = (items, minItems = 0) => ({ type: "array", items, minItems, uniqueItems: true });
const strings = array(text, 1);
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const path = { ...text, format: "path" };
const glob = { ...text, format: "glob" };
const globs = array(glob, 1);
const regex = { ...text, format: "regex" };
const exempt = object({ path, reason }, ["path", "reason"]);
const project = object({
  root: path, profile: { ...text, pattern: "^[a-z][a-z0-9-]*$" }, options: { type: "object" },
  tsconfigs: array(path, 1), knip: bool, surface: object({ snapshot: { ...path, pattern: "\\.surface\\.json$" }, tsconfig: path, signatures: bool }, ["snapshot"]),
  uniqueExports: array(path, 1), compileCommands: path, prepare: array(array(text, 1), 1),
}, ["root", "profile"]);
const contracts = object({
  boundaries: array(object({ from: globs, deny: globs, reason }, ["from", "deny", "reason"])),
  manifests: array(object({ file: path, variable: text, entry: text, exempt: array(exempt) }, ["file", "variable", "entry"])),
  registrations: array(object({ sources: path, call: object({ name: text, from: path }, ["name", "from"]), registrar: object({ files: glob, suffix: text }, ["files", "suffix"]), composition: object({ file: path, function: text }, ["file", "function"]) }, ["sources", "call", "registrar", "composition"])),
  lazyModules: array(object({ loader: path, listing: object({ file: path, pattern: regex, root: path }, ["file", "pattern", "root"]), names: object({ files: glob, pattern: regex }, ["files", "pattern"]) }, ["loader", "names"])),
  writtenOnce: array(object({ table: path, values: regex, files: globs, ignore: globs }, ["table", "values", "files"])),
  importGraphs: array(object({ entries: globs, within: path, refuse: object({ packages: regex, specifiers: regex, extensions: strings }), reason }, ["entries", "within", "refuse", "reason"])),
});

export const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: "urn:plumb:policy:v1",
  title: "Plumb policy", ...object({
    $schema: text, schemaVersion: { const: 1 }, preset: { enum: ["ozlabs", "portable"] }, projects: array(project),
    bundles: array(BUNDLE_REFERENCE_SCHEMA, 1),
    exclude: array(object({ files: globs, reason }, ["files", "reason"])),
    files: object({ required: array(path), forbidden: globs, names: array(object({ files: globs, pattern: regex, reason }, ["files", "pattern", "reason"])), maxLines: integer }),
    docs: object({ index: path }),
    generated: array(object({ path, content: { type: "string" }, executable: bool }, ["path", "content"])),
    format: object({ ignore: array(object({ path: glob, reason }, ["path", "reason"])) }),
    contracts, conventions: CONVENTIONS_SCHEMA, policyTests: POLICY_TESTS_SCHEMA,
    javascript: { type: "object" },
    exceptions: array(object({ id: { ...text, pattern: "^[a-z][a-z0-9-]*$" }, rules: strings, files: globs, reason, max: integer, expires: { ...text, pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }, ["id", "rules", "files", "reason", "max"])),
    policy: object({ protected: globs }),
    tools: object({ timeout: { ...integer, maximum: 3600000 }, versions: { type: "object", additionalProperties: text } }),
    verification: array(object({
      id: { ...text, pattern: "^[a-z][a-z0-9-]*$" }, command: array(text, 1), cwd: path,
      format: { enum: ["junit", "plumb-json"] }, report: { enum: ["stdout", "file"] },
      minTests: integer, maxSkipped: { type: "integer", minimum: 0 }, timeout: { ...integer, maximum: 3600000 },
      env: { type: "object", additionalProperties: { type: "string" } },
      inheritEnv: array({ ...text, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
    }, ["id", "command", "format"])),
  }, ["schemaVersion"]),
};


function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function normalizePaths(value, shape) {
  if (shape.format === "path") return normalize(value);
  if (Array.isArray(value) && shape.items) return value.map((item) => normalizePaths(item, shape.items));
  if (value && typeof value === "object" && shape.properties) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape.properties[key] ? normalizePaths(item, shape.properties[key]) : item]));
  return value;
}
export function definePlumb(input) {
  validateSchema(input, schema);
  if (Object.hasOwn(input, "bundles")) throw new TypeError("Resolve pinned bundles with loadConfig before defining the effective policy");
  const config = structuredClone({ preset: "ozlabs", projects: [], exclude: [], exceptions: [], ...normalizePaths(input, schema) });
  validatePolicyTests(config.policyTests);
  validateConventions(config.conventions);
  const roots = new Set();
  for (const project of config.projects) {
    project.root = normalize(project.root);
    const key = `${project.root}:${["typescript", "react"].includes(project.profile) ? "javascript" : project.profile}`;
    if (roots.has(key)) throw new TypeError(`Duplicate project ${key}`);
    roots.add(key);
    if (project.profile === "cpp" && !project.compileCommands) throw new TypeError(`projects ${project.root}: cpp requires compileCommands`);
    if (!["typescript", "react"].includes(project.profile) && ["tsconfigs", "knip", "surface", "uniqueExports"].some((key) => key in project)) throw new TypeError(`projects ${project.root}: JavaScript options require a typescript or react profile`);
  }
  const ids = new Set();
  for (const suite of config.verification ?? []) {
    if (ids.has(suite.id)) throw new TypeError(`Duplicate verification suite ${suite.id}`);
    ids.add(suite.id);
  }
  ids.clear();
  for (const exception of config.exceptions) {
    if (ids.has(exception.id)) throw new TypeError(`Duplicate exception id ${exception.id}`);
    ids.add(exception.id);
    if (exception.expires && (!Number.isFinite(Date.parse(exception.expires)) || new Date(exception.expires).toISOString().slice(0, 10) !== exception.expires)) throw new TypeError(`Exception ${exception.id}: invalid expiry date`);
  }
  for (const generated of config.generated ?? []) {
    if (generated.path === "plumb.json" || generated.path.endsWith(".surface.json")) throw new TypeError(`generated ${generated.path}: sync cannot replace policy or API expectations`);
  }
  return freeze(config);
}

export function loadConfig(root, file = "plumb.json", policy) {
  const path = policy ? resolve(policy) : safePath(root, file);
  let source, bytes;
  try { bytes = readFileSync(path); source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (error) { throw new Error(`Cannot read UTF-8 policy ${path}: ${error.message}`); }
  let resolved;
  try { resolved = resolvePolicy(path, bytes, { schema, validate: validateSchema }); }
  catch (error) { throw new TypeError(`${path}: ${error.message}`); }
  return { config: definePlumb(resolved.value), source, path, origins: resolved.origins, policyInputs: resolved.inputs };
}
