import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { canonical, digest, isWithin, normalize, safePath } from "./files.mjs";

export const BUNDLE_REFERENCE_SCHEMA = {
  type: "object", required: ["path", "sha256"], additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    bindings: { type: "object", additionalProperties: { type: "string", minLength: 1, format: "path" } },
  },
};

const additive = new Set(["/projects", "/files/required", "/files/forbidden", "/files/names", "/policy/protected", "/verification", "/policyTests", "/conventions/files", "/conventions/roles", "/javascript/rules", "/javascript/syntax", "/javascript/clientDirective"]);
const allowances = new Set(["/exclude", "/exceptions", "/format/ignore", "/javascript/source", "/javascript/words", "/javascript/lines", "/javascript/errorFactory/allowIn"]);
const isAdditive = (path) => additive.has(path) || /^\/contracts\/[^/]+$/.test(path);
const escape = (key) => key.replaceAll("~", "~0").replaceAll("/", "~1");
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function localFile(file, directory) {
  if (typeof file !== "string" || !file || file.includes("\0") || /^[a-z][a-z0-9+.-]*:\/\//i.test(file) || file.startsWith("file:")) throw new TypeError("Policy bundles must use local filesystem paths");
  if (normalize(file).split("/").includes("..")) throw new TypeError(`Bundle paths cannot traverse parent directories: ${file}`);
  const absolute = isAbsolute(file) ? safePath(dirname(file), basename(file)) : safePath(directory, file);
  if (!lstatSync(absolute).isFile()) throw new TypeError(`Policy bundle is not a regular file: ${file}`);
  return realpathSync(absolute);
}

function bindPaths(value, shape, bindings, validate, used = new Set()) {
  if (shape?.format === "path" || shape?.format === "glob") {
    if (typeof value !== "string" || !value.includes("${")) return value;
    const match = /^\$\{([a-z][a-z0-9_-]*)\}(?:\/|$)/i.exec(value);
    if (!match || !Object.hasOwn(bindings, match[1]) || value.slice(match[0].length).includes("${")) throw new TypeError(`Unresolved or misplaced policy path binding: ${value}`);
    const bound = bindings[match[1]];
    validate(bound, { type: "string", minLength: 1, format: "path" }, `bindings.${match[1]}`);
    if (/[?*{}]/.test(bound)) throw new TypeError(`Binding ${match[1]} must be a literal repository path`);
    used.add(match[1]);
    const result = value.replace(`\${${match[1]}}`, normalize(bound));
    return shape.format === "path" ? normalize(result) : result;
  }
  if (Array.isArray(value)) return value.map((item) => bindPaths(item, shape?.items, bindings, validate, used));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindPaths(item, shape?.properties?.[key] ?? (plain(shape?.additionalProperties) ? shape.additionalProperties : undefined), bindings, validate, used)]));
  return value;
}

function provenance(value, source, pointer = "", output = {}) {
  output[pointer] = [{ ...source, pointer }];
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) provenance(item, source, `${pointer}/${escape(key)}`, output);
  return output;
}

function compose(left, right) {
  const origins = clone(left.origins);
  const combine = (destination, source = destination) => {
    for (const [path, entries] of Object.entries(right.origins)) {
      if (path !== source && !path.startsWith(`${source}/`)) continue;
      const key = destination + path.slice(source.length);
      origins[key] = [...new Map([...(origins[key] ?? []), ...entries].map((entry) => [canonical(entry), entry])).values()];
    }
  };
  const nodeOrigin = (path) => { origins[path] = [...new Map([...(origins[path] ?? []), ...(right.origins[path] ?? [])].map((entry) => [canonical(entry), entry])).values()]; };
  const addition = (value, path) => {
    if (path.startsWith("/javascript/") && !["/javascript/rules", "/javascript/syntax", "/javascript/clientDirective"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) throw new TypeError(`An overlay cannot reconfigure ${path}`);
    if (Array.isArray(value)) {
      if (value.length && !isAdditive(path)) throw new TypeError(`An overlay cannot add or widen ${path}; update the pinned bundle instead`);
    } else if (plain(value)) for (const [key, item] of Object.entries(value)) addition(item, `${path}/${escape(key)}`);
    else if (allowances.has(path) || path === "/javascript/tailwind") throw new TypeError(`An overlay cannot reconfigure ${path}`);
  };
  const merge = (before, after, path = "") => {
    if (canonical(before) === canonical(after)) { combine(path); return clone(before); }
    nodeOrigin(path);
    if (Array.isArray(before) && Array.isArray(after)) {
      if (!isAdditive(path)) throw new TypeError(`Conflicting policy values at ${path}; imported allowances cannot be changed by an overlay`);
      const result = clone(before);
      for (const [index, item] of after.entries()) {
        let target = result.findIndex((entry) => canonical(entry) === canonical(item));
        if (target < 0) {
          if (path === "/projects") {
            const family = (profile) => ["typescript", "react"].includes(profile) ? "javascript" : profile;
            if (result.some((entry) => family(entry.profile) === family(item.profile) && (isWithin(normalize(entry.root), normalize(item.root)) || isWithin(normalize(item.root), normalize(entry.root))))) throw new TypeError(`Conflicting or overlapping imported project owner: ${item.root}`);
          }
          if (path === "/verification" && result.some((entry) => entry.id === item.id)) throw new TypeError(`Conflicting verification suite: ${item.id}`);
          target = result.length; result.push(clone(item));
        }
        combine(`${path}/${target}`, `${path}/${index}`);
      }
      return result;
    }
    if (plain(before) && plain(after)) {
      const result = clone(before);
      for (const [key, item] of Object.entries(after)) {
        const next = `${path}/${escape(key)}`;
        if (Object.hasOwn(before, key)) result[key] = merge(before[key], item, next);
        else { addition(item, next); result[key] = clone(item); combine(next); }
      }
      return result;
    }
    if (path === "/preset" && before === "portable" && after === "ozlabs") { combine(path); return after; }
    throw new TypeError(`Conflicting policy values at ${path || "/"}; overlays cannot override imported values`);
  };
  return { value: merge(left.value, right.value), origins };
}

// Resolution is explicit and offline. Imported files are checked before their data is used.
export function resolvePolicy(path, source, { schema, validate } = {}) {
  if (!schema || typeof validate !== "function") throw new TypeError("Policy resolution needs the runtime schema and validator");
  const stack = new Set(), inputs = new Map();
  let visits = 0;
  const visit = (file, contents, bindings = {}, expected) => {
    if (++visits > 128 || stack.size >= 32) throw new TypeError("Policy bundle graph exceeds its supported size");
    if (stack.has(file)) throw new TypeError(`Policy bundle cycle at ${file}`);
    const sha256 = digest(contents);
    if (expected && sha256 !== expected) throw new TypeError(`Policy bundle hash mismatch: ${file}`);
    if (inputs.has(file) && inputs.get(file) !== sha256) throw new TypeError(`Policy bundle changed during resolution: ${file}`);
    inputs.set(file, sha256); stack.add(file);
    try {
      const raw = JSON.parse(typeof contents === "string" ? contents : new TextDecoder("utf-8", { fatal: true }).decode(contents)), used = new Set();
      const bindingShape = { ...schema, properties: { ...schema.properties, bundles: { type: "array", items: BUNDLE_REFERENCE_SCHEMA } } };
      const parsed = bindPaths(raw, bindingShape, bindings, validate, used);
      for (const name of Object.keys(bindings)) if (!used.has(name)) throw new TypeError(`Unused policy path binding: ${name}`);
      const references = parsed.bundles ?? [];
      validate(references, { type: "array", items: BUNDLE_REFERENCE_SCHEMA, uniqueItems: true }, "bundles");
      const { bundles: _bundles, ...value } = parsed;
      validate(value, schema, file);
      let inherited;
      for (const reference of references) {
        const target = localFile(reference.path, dirname(file));
        const resolved = visit(target, readFileSync(target), reference.bindings, reference.sha256);
        inherited = inherited ? compose(inherited, resolved) : resolved;
      }
      const own = { value: references.length ? value : { preset: "ozlabs", ...value }, origins: provenance(value, { path: file, sha256 }) };
      if (!references.length && !Object.hasOwn(value, "preset")) own.origins["/preset"] = [{ path: file, pointer: "", sha256, default: true }];
      const result = inherited ? compose(inherited, own) : own;
      validate(result.value, schema, file);
      return result;
    } finally { stack.delete(file); }
  };
  const root = localFile(resolve(path), dirname(resolve(path)));
  const result = visit(root, source ?? readFileSync(root));
  return { ...result, inputs: [...inputs].sort(([a], [b]) => order(a, b)).map(([path, sha256]) => ({ path, sha256 })) };
}

export function diffPolicies(before, after) {
  const previous = before?.value ?? before?.config ?? before, next = after?.value ?? after?.config ?? after, result = [], absent = Symbol("absent");
  const walk = (left, right, path = "") => {
    if (left !== absent && right !== absent && canonical(left) === canonical(right)) return;
    if (left !== absent && right !== absent && plain(left) && plain(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(order)) walk(Object.hasOwn(left, key) ? left[key] : absent, Object.hasOwn(right, key) ? right[key] : absent, `${path}/${escape(key)}`);
      return;
    }
    result.push({ path: path || "/", kind: left === absent ? "added" : right === absent ? "removed" : "changed", ...(left !== absent ? { before: clone(left) } : {}), ...(right !== absent ? { after: clone(right) } : {}), ...(before?.origins?.[path] ? { beforeOrigins: before.origins[path] } : {}), ...(after?.origins?.[path] ? { afterOrigins: after.origins[path] } : {}) });
  };
  walk(previous, next);
  return result;
}
