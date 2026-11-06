import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonical, digest, globMatches, inventory, safePath, snapshot } from "./files.mjs";

const inside = (root, path) => { const local = relative(root, path); return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`); };
const fullSnapshot = (root) => {
  const found = inventory(root);
  if (found.problems.length) throw new Error("Unsafe inputs prevent cache reuse");
  const directories = [];
  const walk = (path) => {
    const absolute = safePath(root, path);
    directories.push([path, lstatSync(absolute).mode & 0o7777]);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) if (entry.isDirectory() && ![".git", ".hg", ".svn", "node_modules"].includes(entry.name)) walk(path === "." ? entry.name : `${path}/${entry.name}`);
  };
  // Markdown links can name an empty directory, including an ignored directory.
  walk(".");
  return digest(canonical({ files: snapshot(root, found.files), directories: directories.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) }));
};
const mutation = (message) => Object.assign(new Error(message), { code: "PLUMB_CACHE_MUTATED" });
const disabled = (reason) => ({ info: { enabled: false, hit: false, reason } });

function validResult(value, checker, policy, source, files) {
  if (value?.schemaVersion !== 1 || value.command !== "check" || value.status !== "pass" || value.exitCode !== 0 || !Array.isArray(value.diagnostics) || value.diagnostics.length) return false;
  if (canonical(value.identity?.checker) !== canonical(checker) || value.identity?.snapshot !== source || value.identity?.policy !== policy || value.identity?.subject?.kind !== "worktree" || value.identity.subject.snapshot !== source) return false;
  if (!Array.isArray(value.checks) || !Array.isArray(value.coverage) || !Array.isArray(value.files) || !Array.isArray(value.suppressed) || !Array.isArray(value.tests) || value.tests.length) return false;
  const ids = (entries) => entries.map((entry) => entry?.id).sort();
  if (canonical(ids(value.checks)) !== canonical(["comments", "files", "generated", "javascript", "native"]) || value.checks.some((check) => !["pass", "not-applicable"].includes(check.status))) return false;
  if (canonical(ids(value.coverage)) !== canonical(["comments", "files", "generated"]) || value.coverage.some((row) => !Array.isArray(row.checkedFiles) || !["pass", "not-applicable"].includes(row.status) || row.completed !== (row.status === "pass"))) return false;
  return canonical(value.files.map((file) => file?.path).sort()) === canonical([...files].sort());
}

// Only deterministic core checks are reusable. Tool and behavioral checks always execute.
export function prepareCache(ctx, options, checker) {
  if (!options.cache) return undefined;
  if (ctx.config.policyTests?.length || ctx.config.conventions) return disabled("Convention and policy acceptance checks execute afresh.");
  if (process.env.CI && !/^(?:false|0)$/i.test(process.env.CI)) return disabled("CI checks always execute; local caching is disabled when CI is truthy.");
  const unsupported = ctx.config.projects.length || ctx.config.javascript !== undefined || Object.values(ctx.config.contracts ?? {}).some((rows) => rows.length) || ctx.config.verification?.length || ctx.registry || options.adapters || options.registry || options.loadedTask || options.task || options.inputBundle || options.inputManifest || options.subjectContext || options.workspace;
  if (unsupported) return disabled("Language, behavioral, task and approved-input checks always execute; caching currently covers deterministic core checks only.");
  const root = realpathSync(ctx.root), destination = resolve(options.cache);
  let ancestor = destination;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), relative(ancestor, destination));
  if (inside(root, actual)) throw new Error("The cache must be outside the candidate repository");
  const scope = inventory(root);
  const selected = scope.files.filter((path) => !ctx.config.exclude.some((entry) => globMatches(entry.files, path)));
  if (canonical(selected) !== canonical(ctx.files) || scope.files.some((path) => !ctx.allFiles.includes(path))) throw mutation("Repository inventory changed before cache validation");
  let source, selectedSource;
  try { source = fullSnapshot(root); selectedSource = snapshot(root, ctx.allFiles); }
  catch (error) { return disabled(error.message); }
  const date = ctx.config.exceptions.some((entry) => entry.expires) ? options.date ?? new Date().toISOString().slice(0, 10) : undefined;
  const policy = digest(canonical(ctx.config)), scopeIdentity = canonical(scope);
  const key = digest(canonical({ schemaVersion: 1, root, source, scope, selected: ctx.files, allFiles: ctx.allFiles, configFile: ctx.configFile, policy, policyInputs: ctx.policyInputs, checker, runtime: { node: process.versions.node, bun: process.versions.bun }, platform: process.platform, date }));
  const path = join(actual, `${key}.json`), info = { enabled: true, hit: false, key, scope: "deterministic-core" };
  const verify = () => {
    try {
      if (canonical(inventory(root)) !== scopeIdentity || fullSnapshot(root) !== source) throw new Error("Cache source inputs or selected inventory changed during the run");
      for (const item of ctx.policyInputs) if (!lstatSync(item.path).isFile() || realpathSync(item.path) !== item.path || digest(readFileSync(item.path)) !== item.sha256) throw new Error("Cache policy input changed during the run");
      options.subjectContext?.verify?.();
    } catch (error) { throw mutation(error.message); }
  };
  let result;
  if (existsSync(path)) {
    try {
      if (!lstatSync(path).isFile() || realpathSync(path) !== path) throw new Error("Cache receipts must be regular files at their approved path");
      if (lstatSync(path).size > 16 * 1024 * 1024) throw new Error("Oversized cache receipt");
      const bytes = readFileSync(path);
      const receipt = JSON.parse(bytes);
      if (receipt.schemaVersion !== 1 || receipt.key !== key || !validResult(receipt.result, checker, policy, selectedSource, ctx.allFiles) || receipt.sha256 !== digest(canonical(receipt.result))) throw new Error("Cache receipt is invalid");
      verify(); result = receipt.result; info.hit = true;
    } catch (error) { if (error.code === "PLUMB_CACHE_MUTATED") throw error; info.reason = `Receipt was not reused: ${error.message}`; }
  }
  return { info, result, verify, save(value) {
    if (!validResult(value, checker, policy, selectedSource, ctx.allFiles)) return;
    verify();
    mkdirSync(actual, { recursive: true });
    if (realpathSync(actual) !== actual || inside(root, realpathSync(actual))) throw new Error("Cache destination changed from its approved external path");
    const temporary = join(actual, `.${key}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, key, sha256: digest(canonical(value)), result: value }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      verify();
    }
    finally { rmSync(temporary, { force: true }); }
  } };
}
