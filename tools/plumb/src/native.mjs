import { existsSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";

import { CLANG_FORMAT } from "./assets.mjs";
import { isWithin, normalize, safePath } from "./files.mjs";

export const RULES = [
  { id: "native.scope", description: "Native projects select source files and required build metadata.", remedy: "Correct the project scope and generate its compilation database.", suppressible: false },
  { id: "ruby.lint", description: "Ruby passes the pinned RuboCop policy.", remedy: "Resolve RuboCop's diagnostics.", suppressible: false },
  { id: "cpp.format", description: "C/C++ passes the pinned clang-format policy.", remedy: "Run plumb fix, then resolve remaining include-order or brace findings manually.", suppressible: false },
  { id: "cpp.lint", description: "C/C++ passes clang-tidy with warnings as errors.", remedy: "Resolve clang-tidy's diagnostics.", suppressible: false },
];

const CPP = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/;
const RUBY = /\.(?:rb|rake|gemspec)$|(?:^|\/)(?:Gemfile|Rakefile)$/;
export const nativeSource = (profile, path) => (profile === "ruby" ? RUBY : profile === "cpp" ? CPP : undefined)?.test(path) ?? false;

function checkFormatIgnores(folder, sources, read) {
  const directories = new Set([folder]);
  for (const source of sources) {
    for (let directory = posix.dirname(source); isWithin(folder, directory); directory = posix.dirname(directory)) {
      directories.add(directory);
      if (directory === folder) break;
    }
  }
  for (const directory of directories) {
    const path = posix.join(directory, ".clang-format-ignore");
    const content = read(path, { allowMissing: true });
    if (content === null) {
      if (directory === folder) throw new Error(`${path}: run plumb sync to isolate formatting from inherited ignore files`);
      continue;
    }
    if (content.split(/\r?\n/).some((line) => line.trim() && !line.trimStart().startsWith("#"))) throw new Error(`${path}: clang-format ignore patterns can hide selected source; declare reviewed exclusions in plumb.json instead`);
  }
}

// command arguments are separate values; project data never becomes a shell command.
export function nativeSteps({ root, files, config, read = (path, { allowMissing = false } = {}) => {
  try { return readFileSync(safePath(root, path, { allowMissing }), "utf8"); }
  catch (error) { if (allowMissing && error.code === "ENOENT") return null; throw error; }
} }, mode = "check") {
  const steps = [];
  const fix = mode === "fix";
  const projects = (config.projects ?? []).map((project) => ({ ...project, root: normalize(project.root) }));
  for (const project of projects) {
    if (!["ruby", "cpp"].includes(project.profile)) continue;
    const folder = project.root;
    const cwd = safePath(root, folder);
    const sources = files.filter((path) => isWithin(folder, path) && nativeSource(project.profile, path) && !projects.some((other) => other.profile === project.profile && other.root !== folder && isWithin(folder, other.root) && isWithin(other.root, path))).sort();
    if (!sources.length) throw new Error(`${folder}: no ${project.profile} source files matched the configured project`);
    const selected = sources.map((path) => `./${relative(cwd, safePath(root, path)).replaceAll("\\", "/")}`);
    const step = (name, tool, command, versionCommand, checkedFiles = sources) => ({
      id: `${project.profile}.${name}:${folder}`, rule: `${project.profile}.${name}`, tool, path: folder, cwd, command, versionCommand, fix, files: checkedFiles,
    });
    if (project.profile === "ruby") {
      const launch = process.platform === "win32" ? ["ruby", "-S"] : [];
      const command = [...launch, ...(existsSync(join(cwd, "Gemfile")) ? ["bundle", "exec", "rubocop"] : ["rubocop"])];
      steps.push(step("lint", "rubocop", [...command, "--config", join(cwd, ".rubocop.yml"), "--cache", "false", "--format", fix ? "simple" : "json", ...(fix ? ["--autocorrect"] : []), "--", ...selected], [...command, "--version"]));
      continue;
    }
    checkFormatIgnores(folder, sources, read);
    const style = fix ? JSON.stringify({ ...CLANG_FORMAT, SortIncludes: "Never", IncludeBlocks: "Preserve", InsertBraces: false }) : `file:${join(cwd, ".clang-format")}`;
    steps.push(step("format", "clang-format", ["clang-format", `--style=${style}`, ...(fix ? ["-i"] : ["--dry-run", "--Werror"]), "--", ...selected], ["clang-format", "--version"]));
    if (fix) continue;
    const units = selected.filter((path) => !/\.(?:h|hh|hpp|hxx)$/.test(path));
    if (!units.length) throw new Error(`${folder}: clang-tidy needs at least one C/C++ translation unit that includes the headers`);
    const databasePath = project.compileCommands ?? (folder === "." ? "build" : `${folder}/build`);
    const database = safePath(root, databasePath, { allowMissing: true });
    const databaseFile = safePath(root, `${databasePath}/compile_commands.json`, { allowMissing: true });
    if (!existsSync(databaseFile)) throw new Error(`${folder}: ${databasePath}/compile_commands.json is missing; generate the compilation database before checking`);
    const commands = JSON.parse(read(`${databasePath}/compile_commands.json`));
    if (!Array.isArray(commands) || commands.some((entry) => !entry || typeof entry.directory !== "string" || typeof entry.file !== "string" || !(typeof entry.command === "string" && entry.command.trim() || Array.isArray(entry.arguments) && entry.arguments.length && entry.arguments.every((value) => typeof value === "string")))) throw new Error(`${folder}: compile_commands.json must contain compiler command objects with directory, file and command or arguments`);
    const compiled = new Set(commands.map((entry) => resolve(database, entry.directory, entry.file)));
    const missing = units.filter((path) => !compiled.has(resolve(cwd, path)));
    if (missing.length) throw new Error(`${folder}: the compilation database has no compiler command for ${missing.join(", ")}; regenerate it before checking`);
    steps.push(step("lint", "clang-tidy", ["clang-tidy", "--config-file", join(cwd, ".clang-tidy"), "-p", database, "--quiet", ...units], ["clang-tidy", "--version"], sources.filter((file) => !/\.(?:h|hh|hpp|hxx)$/.test(file))));
  }
  return steps;
}
