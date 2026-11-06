import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { canonical, digest, inventory, normalize, safePath, snapshot } from "./files.mjs";

const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const inside = (root, path) => { const local = relative(root, path); return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local); };
const utf8 = (value) => new TextDecoder("utf-8", { fatal: true }).decode(value);

function name(value, dependencies = false) {
  if (typeof value !== "string" || value === "." || !value || value.includes("\0") || normalize(value) !== value || isAbsolute(value) || /^[a-z]:/i.test(value)) throw new Error(`Unsupported relative path: ${value}`);
  if (value.split("/").some((part) => ["..", ".git", ".hg", ".svn", ...dependencies ? [] : ["node_modules"]].includes(part.toLowerCase()))) throw new Error(`Reserved or escaping path: ${value}`);
  return value;
}

function temporary(root, preferred) {
  const parent = resolve(preferred ?? process.env.PLUMB_TEST_TMP ?? tmpdir());
  if (inside(root, parent)) throw new Error("Temporary workspaces must be outside the candidate root");
  mkdirSync(parent, { recursive: true });
  const actual = realpathSync(parent);
  if (inside(root, actual)) throw new Error("Temporary workspaces must be outside the candidate root");
  const container = mkdtempSync(join(actual, "plumb-workspace-"));
  const target = join(container, "project");
  mkdirSync(target);
  return { root: target, container, cleanup: () => rmSync(container, { recursive: true, force: true }) };
}

export function copyWorkspace(candidateRoot, { files, extraFiles = [], temporaryRoot } = {}) {
  const found = inventory(candidateRoot);
  if (found.problems.length) throw new Error(found.problems.map((item) => item.message).join("; "));
  const selected = [...new Set([...(files ?? found.files), ...extraFiles].map((path) => name(path)))].sort(compare);
  const modes = () => selected.map((path) => [path, lstatSync(safePath(found.root, path)).mode & 0o777]);
  const identity = { snapshot: snapshot(found.root, selected), permissions: digest(canonical(modes())) };
  const workspace = temporary(found.root, temporaryRoot);
  const verify = () => {
    const after = inventory(found.root);
    if (after.problems.length || canonical(after.files) !== canonical(found.files) || snapshot(found.root, selected) !== identity.snapshot || digest(canonical(modes())) !== identity.permissions) throw new Error("Workspace inputs changed while preparing an isolated copy");
    return true;
  };
  try {
    for (const path of selected) {
      const source = safePath(found.root, path), target = safePath(workspace.root, path, { allowMissing: true });
      if (!lstatSync(source).isFile()) throw new Error(`Only regular files can be copied: ${path}`);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target, constants.COPYFILE_EXCL); chmodSync(target, lstatSync(source).mode & 0o777);
    }
    verify();
    if (snapshot(workspace.root, selected) !== identity.snapshot) throw new Error("Isolated workspace does not match the selected source inputs");
    return { root: workspace.root, files: selected, identity, verify, cleanup: workspace.cleanup };
  } catch (error) { workspace.cleanup(); throw error; }
}

function ordinaryAbsolute(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("Input sources must be absolute filesystem paths");
  const target = resolve(path);
  let cursor = parse(target).root;
  for (const part of relative(cursor, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Input symlinks are not supported: ${path}`);
  }
  return target;
}
function fileDigest(path) {
  const hash = createHash("sha256"), file = openSync(path, "r"), buffer = Buffer.allocUnsafe(65536);
  try { for (let count; (count = readSync(file, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, count)); }
  finally { closeSync(file); }
  return hash.digest("hex");
}
function inputRecords(path) {
  const source = ordinaryAbsolute(path), rows = [];
  const walk = (absolute, local) => {
    const stat = lstatSync(absolute), mode = stat.mode & 0o777;
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Input trees contain only regular files and directories: ${absolute}`);
    rows.push({ path: local, kind: stat.isFile() ? "file" : "directory", mode, ...(stat.isFile() ? { sha256: fileDigest(absolute) } : {}) });
    if (stat.isDirectory()) for (const child of readdirSync(absolute).sort(compare)) {
      name(child, true);
      walk(join(absolute, child), local === "." ? child : `${local}/${child}`);
    }
  };
  walk(source, ".");
  return rows;
}

// Input pins hash canonical paths, file bytes and permission modes, including empty directories.
export const inputDigest = (source) => digest(canonical(inputRecords(source)));

export function loadInputs(manifestFile, candidateRoot) {
  const path = ordinaryAbsolute(resolve(manifestFile)), candidate = realpathSync(candidateRoot);
  if (inside(candidate, path)) throw new Error("The approved inputs manifest must be outside the candidate root");
  const source = readFileSync(path, "utf8"), data = JSON.parse(source);
  if (!data || typeof data !== "object" || Array.isArray(data) || data.schemaVersion !== 1 || !Array.isArray(data.files) || Object.keys(data).some((key) => !["schemaVersion", "files"].includes(key))) throw new Error("Inputs manifest requires schemaVersion: 1 and a files array");
  const entries = data.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => !["path", "source", "sha256"].includes(key)) || !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? "")) throw new Error("Each input needs path, absolute source and sha256");
    name(entry.path, true);
    const absolute = ordinaryAbsolute(entry.source), records = inputRecords(absolute), sha256 = digest(canonical(records));
    if (sha256 !== entry.sha256.toLowerCase()) throw new Error(`Input pin does not match ${entry.path}`);
    return Object.freeze({ path: entry.path, source: absolute, sha256, kind: records[0].kind, records: Object.freeze(records.map(Object.freeze)) });
  });
  for (let i = 0; i < entries.length; i++) for (const other of entries.slice(i + 1)) if (entries[i].path === other.path || entries[i].path.startsWith(`${other.path}/`) || other.path.startsWith(`${entries[i].path}/`)) throw new Error("Input destinations must not overlap");
  const identity = Object.freeze({ sha256: digest(canonical({ manifest: digest(source), entries: entries.map(({ path, sha256, kind }) => ({ path, sha256, kind })) })), files: Object.freeze(entries.map(({ path, sha256, kind }) => Object.freeze({ path, sha256, kind }))) });
  return Object.freeze({ path, entries: Object.freeze(entries), identity, verify() {
    if (readFileSync(ordinaryAbsolute(path), "utf8") !== source) throw new Error("The approved inputs manifest changed during checking");
    for (const entry of entries) if (inputDigest(entry.source) !== entry.sha256) throw new Error(`Approved input changed during checking: ${entry.path}`);
    return true;
  } });
}

function inputTarget(root, path) {
  name(path, true);
  let cursor = realpathSync(root);
  const target = join(cursor, ...path.split("/"));
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Input destination follows a symlink: ${path}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; break; }
  }
  return target;
}

export function materializeInputs(targetRoot, loaded) {
  const root = realpathSync(targetRoot), planned = [];
  loaded.verify();
  for (const entry of loaded.entries) for (const row of entry.records) {
    const path = row.path === "." ? entry.path : `${entry.path}/${row.path}`, target = inputTarget(root, path);
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (row.kind === "file" || !stat.isDirectory() || (stat.mode & 0o777) !== row.mode) throw new Error(`Approved input collides with existing snapshot content: ${path}`);
    }
    planned.push({ ...row, path, target, source: row.path === "." ? entry.source : join(entry.source, ...row.path.split("/")) });
  }
  const created = [], directories = [];
  const ensureDirectory = (path) => {
    if (path === root || existsSync(path)) return;
    ensureDirectory(dirname(path)); mkdirSync(path, { mode: 0o700 }); created.push(path); directories.push({ path, mode: 0o755 });
  };
  try {
    for (const row of planned) {
      inputTarget(root, row.path);
      ensureDirectory(dirname(row.target));
      if (row.kind === "directory") {
        if (!existsSync(row.target)) { mkdirSync(row.target, { mode: 0o700 }); created.push(row.target); directories.push({ path: row.target, mode: row.mode }); }
      } else {
        ordinaryAbsolute(row.source);
        copyFileSync(row.source, row.target, constants.COPYFILE_EXCL); created.push(row.target); chmodSync(row.target, row.mode);
        if (fileDigest(row.target) !== row.sha256) throw new Error(`Approved input changed while copying: ${row.path}`);
      }
    }
    for (const directory of directories.reverse()) chmodSync(directory.path, directory.mode);
    loaded.verify();
    const state = loaded.entries.map((entry) => ({ path: entry.path, sha256: inputDigest(inputTarget(root, entry.path)) }));
    return { identity: loaded.identity, files: planned.filter((row) => row.kind === "file").map((row) => row.path).sort(compare), verify() {
      loaded.verify();
      for (const entry of state) if (inputDigest(inputTarget(root, entry.path)) !== entry.sha256) throw new Error(`Materialized input changed during checking: ${entry.path}`);
      return true;
    } };
  } catch (error) {
    for (const path of created) { try { if (lstatSync(path).isDirectory()) chmodSync(path, 0o700); } catch {} }
    for (const path of created.reverse()) { try { if (lstatSync(path).isDirectory()) rmdirSync(path); else rmSync(path, { force: true }); } catch {} }
    throw error;
  }
}
