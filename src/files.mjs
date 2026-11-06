import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const normalize = (value) => value.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/\/$/, "").split("/").filter((part) => part !== ".").join("/") || ".";
export const isWithin = (parent, path) => path === parent || path.startsWith(`${parent}/`) || parent === ".";
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);

export function safePath(root, path, { allowMissing = false, allowDependencies = false } = {}) {
  if (typeof path !== "string" || !path || path.includes("\0") || isAbsolute(path) || /^[a-z]:/i.test(path)) throw new Error(`Expected a repository-relative path: ${path}`);
  const clean = normalize(path);
  if (clean.split("/").includes("..")) throw new Error(`Path escapes the repository: ${path}`);
  if (clean.split("/").some((part) => [".git", ".hg", ".svn"].includes(part) || part === "node_modules" && !allowDependencies)) throw new Error(`Reserved repository path: ${path}`);
  const base = realpathSync(root);
  const target = resolve(base, clean);
  const local = relative(base, target);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`Path escapes the repository: ${path}`);
  let cursor = base;
  for (const part of local.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Symbolic links are not followed: ${path}`);
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return target;
      throw error;
    }
  }
  return target;
}

const patterns = new Map();
function expand(pattern) {
  if (pattern.length > 1024) throw new Error("Glob is too long");
  const pending = [pattern], result = [];
  while (pending.length) {
    const current = pending.pop(), match = /\{([^{}]*)\}/.exec(current);
    if (!match) { result.push(current); continue; }
    const choices = match[1].split(",");
    if (choices.length + pending.length + result.length > 256) throw new Error("Glob expansion exceeds 256 alternatives");
    pending.push(...choices.map((part) => current.replace(match[0], part)));
  }
  return result;
}
function compile(pattern) {
  const raw = pattern.replaceAll("\\", "/");
  let clean = normalize(raw);
  if (clean === ".") clean = "**";
  else if (raw.endsWith("/")) clean += "/**";
  if (clean.split("/").includes("..") || clean.startsWith("/") || clean.startsWith("!")) throw new Error(`Invalid repository glob: ${pattern}`);
  let source = "";
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (char === "*" && clean[i + 1] === "*") {
      const slash = clean[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
export function globMatches(pattern, path) {
  const list = Array.isArray(pattern) ? pattern : [pattern];
  return list.some((entry) => {
    if (!patterns.has(entry)) patterns.set(entry, expand(entry).map(compile));
    return patterns.get(entry).some((regex) => regex.test(normalize(path)));
  });
}

const omitted = new Set([".git", ".hg", ".svn", "node_modules"]);
export function inventory(root) {
  const base = realpathSync(root);
  const walk = (folder) => readdirSync(join(base, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return omitted.has(entry.name) ? [] : walk(path);
    return [path];
  });
  const files = [], problems = [];
  for (const file of [...new Set(walk("").map(normalize))].sort()) {
    if (file.split("/").some((part) => omitted.has(part))) continue;
    try {
      const target = safePath(base, file);
      const stat = lstatSync(target);
      if (stat.isFile()) files.push(file);
    } catch (error) {
      if (error.code !== "ENOENT") problems.push({ rule: "inventory.unsafe", path: file, status: "incomplete", suppressible: false, message: error.message, remedy: "Use regular repository files; check linked repositories separately." });
    }
  }
  return { root: base, files, problems };
}

export function snapshot(root, files) {
  const hash = createHash("sha256");
  for (const path of [...files].sort()) {
    const target = safePath(root, path);
    const content = createHash("sha256"), buffer = Buffer.allocUnsafe(65536), file = openSync(target, "r");
    try { for (let length; (length = readSync(file, buffer, 0, buffer.length, null));) content.update(buffer.subarray(0, length)); }
    finally { closeSync(file); }
    hash.update(canonical([path, lstatSync(target).mode & 0o111, content.digest("hex")]) + "\n");
  }
  return hash.digest("hex");
}

export const protectedPolicyFiles = ["**/plumb.json", "**/plumb.ratchet.json", "**/plumb.config.*", "**/eslint.config.*", "**/.eslintrc*", "**/tsconfig*.json", "**/package.json", "**/*lock*", "**/Gemfile*", "**/.rubocop*", "**/.clang-*", "**/knip*", "**/.knip*", "**/*.config.*", ".github/workflows/**", ".github/actions/**", "**/.gitignore", "**/.prettier*", "**/.editorconfig", "**/.gitattributes"];

export function isPolicyFile(config, path, configFile = "plumb.json") {
  const snapshots = config.projects.flatMap((project) => project.surface ? [`${project.root === "." ? "" : `${project.root}/`}${project.surface.snapshot}`] : []);
  return globMatches([...protectedPolicyFiles, configFile, ...snapshots, ...(config.policy?.protected ?? [])], path);
}
