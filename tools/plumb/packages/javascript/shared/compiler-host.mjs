import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const metadata = new Set([".git", ".hg", ".svn"]);
const inside = (root, path) => { const name = relative(root, path); return name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name); };
const slash = (path) => path.split(sep).join("/");

// The core records bytes, absence and directory listings. This fallback serves standalone API users.
function ordinary(root, name, allowMissing) {
  const path = resolve(root, name);
  if (!inside(root, path) || name.split(/[\\/]/).some((part) => metadata.has(part))) throw new Error(`Unsafe compiler input: ${name}`);
  let cursor = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Compiler inputs cannot follow symbolic links: ${name}`); }
    catch (error) { if (allowMissing && error.code === "ENOENT") return path; throw error; }
  }
  return path;
}

export function createCompilerIO(repository, context = {}, compiler) {
  const root = resolve(repository), ts = typeof compiler === "function" ? compiler : () => compiler;
  let library;
  const libraryRoot = () => library ??= realpathSync(dirname(ts().getDefaultLibFilePath({})));
  const nameOf = (file) => slash(relative(root, resolve(file))) || ".";
  const candidate = (file) => inside(root, resolve(file));
  const standard = (file, directory = false) => {
    const path = resolve(file), folder = libraryRoot();
    return directory ? path === folder : dirname(path) === folder && /^lib(?:\.[a-z0-9-]+)*\.d\.ts$/i.test(basename(path));
  };
  const listing = (directory) => {
    const path = resolve(directory);
    if (!candidate(path)) {
      if (!standard(path, true)) return null;
      return readdirSync(path, { withFileTypes: true }).map((entry) => ({ name: entry.name, kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
    }
    const name = nameOf(path);
    if (context.readCompilerDirectory) return context.readCompilerDirectory(name, { allowMissing: true });
    try {
      const target = ordinary(root, name, true);
      if (!lstatSync(target).isDirectory()) return null;
      return readdirSync(target, { withFileTypes: true }).map((entry) => ({ name: entry.name, kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })).sort((a, b) => a.name < b.name ? -1 : 1);
    } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; }
  };
  const kind = (file) => {
    const path = resolve(file);
    if (path === root || standard(path, true)) return "directory";
    if (!candidate(path) && !standard(path)) return undefined;
    const entry = listing(dirname(path))?.find((entry) => entry.name === basename(path));
    if (entry && ["symlink", "other"].includes(entry.kind)) throw new Error(`Unsupported compiler input: ${file}`);
    return entry?.kind;
  };
  const readFile = (file) => {
    const path = resolve(file);
    if (!candidate(path)) {
      if (!standard(path)) throw new Error(`Compiler input escapes the checked root: ${file}`);
      return ts().sys.readFile(path);
    }
    const name = nameOf(path), entry = kind(path);
    if (entry === "directory") return undefined;
    let value;
    try {
      value = context.readCompilerInput ? context.readCompilerInput(name, { allowMissing: true }) : !name.split("/").includes("node_modules") && context.read ? context.read(name, { allowMissing: true }) : readFileSync(ordinary(root, name, true), "utf8");
    } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return undefined; throw error; }
    return value === null || value === undefined ? undefined : value.toString().replace(/^\uFEFF/, "");
  };
  const io = {
    readFile,
    fileExists(file) {
      if (!candidate(file) && !standard(file)) return false;
      if (kind(file) === "directory") return false;
      return readFile(file) !== undefined;
    },
    directoryExists(directory) {
      if (kind(directory) !== "directory") return false;
      return listing(directory) !== null;
    },
    getDirectories(directory) { return (listing(directory) ?? []).filter((entry) => entry.kind === "directory" && !metadata.has(entry.name)).map((entry) => entry.name); },
    readDirectory(directory, extensions, excludes, includes, depth) {
      if (!candidate(directory) && !standard(directory, true)) throw new Error(`Compiler directory escapes the checked root: ${directory}`);
      const typescript = ts();
      if (typeof typescript.matchFiles !== "function") throw new Error("This TypeScript release does not provide the required guarded directory matcher");
      return typescript.matchFiles(directory, extensions, excludes, includes, typescript.sys.useCaseSensitiveFileNames, root, depth, (folder) => {
        const entries = listing(folder) ?? [];
        return { files: entries.filter((entry) => entry.kind === "file" && !metadata.has(entry.name)).map((entry) => entry.name), directories: entries.filter((entry) => entry.kind === "directory" && !metadata.has(entry.name)).map((entry) => entry.name) };
      }, io.realpath);
    },
    realpath(file) {
      if (!candidate(file) && !standard(file) && !standard(file, true)) throw new Error(`Compiler resolution escapes the checked root: ${file}`);
      if (candidate(file)) ordinary(root, nameOf(file), true);
      try {
        const path = realpathSync(file);
        if (!candidate(path) && !standard(path) && !standard(path, true)) throw new Error(`Compiler resolution escapes the checked root: ${file}`);
        return path;
      } catch (error) { if (error.code === "ENOENT") return resolve(file); throw error; }
    },
    getCurrentDirectory: () => root,
  };
  Object.defineProperty(io, "useCaseSensitiveFileNames", { enumerable: true, get: () => ts().sys.useCaseSensitiveFileNames });
  return io;
}
