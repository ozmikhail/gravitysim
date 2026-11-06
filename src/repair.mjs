import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { canonical, digest, inventory, isWithin, normalize, safePath } from "./files.mjs";
import { isPolicyFile } from "./policy.mjs";
import { copyWorkspace, materializeInputs } from "./workspace.mjs";

const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (bytes, path) => {
  if (bytes.includes(0)) throw new Error(`Binary files cannot be repaired: ${path}`);
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`Repairs require valid UTF-8 source: ${path}`); }
};
const exactKeys = (value, allowed, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Invalid ${label}`);
};
const modeOf = (path) => lstatSync(path).mode & 0o777;

function writable(ctx, path) {
  if (typeof path !== "string" || normalize(path) !== path) throw new Error(`Invalid repair path: ${path}`);
  const allowed = ctx.writableFiles ?? ctx.files;
  if (!allowed?.includes(path) || ctx.ownedFiles?.includes(path) || path.endsWith(".surface.json") || isPolicyFile(ctx.config, path, ctx.configFile)) throw new Error(`Repair cannot change policy, generated assets, snapshots or unselected files: ${path}`);
  const target = safePath(ctx.root, path);
  if ((ctx.path && resolve(ctx.path) === target) || ctx.protectedFiles?.some((entry) => resolve(ctx.root, entry) === target)) throw new Error(`Repair cannot change a loaded enforcement input: ${path}`);
  if (!lstatSync(target).isFile()) throw new Error(`Repair targets must be regular files: ${path}`);
  return target;
}

const lines = (value) => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const quote = (path) => '"' + path.replace(/["\\\x00-\x1f\x7f]/g, (char) => char === '"' || char === "\\" ? `\\${char}` : `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`) + '"';
const patchLine = (prefix, value) => prefix + value + (value.endsWith("\n") ? "" : "\n\\ No newline at end of file\n");

export function repairPatch(changes) {
  return changes.map(({ path, before, after }) => {
    const a = lines(before), b = lines(after);
    let start = 0, suffix = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    while (suffix < a.length - start && suffix < b.length - start && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
    const from = Math.max(0, start - 3), context = Math.min(3, suffix), oldEnd = a.length - suffix + context, newEnd = b.length - suffix + context;
    const oldCount = oldEnd - from, newCount = newEnd - from;
    return `--- ${quote(`a/${path}`)}\n+++ ${quote(`b/${path}`)}\n@@ -${oldCount ? from + 1 : from},${oldCount} +${newCount ? from + 1 : from},${newCount} @@\n`
      + a.slice(from, start).map((line) => patchLine(" ", line)).join("")
      + a.slice(start, a.length - suffix).map((line) => patchLine("-", line)).join("")
      + b.slice(start, b.length - suffix).map((line) => patchLine("+", line)).join("")
      + a.slice(a.length - suffix, oldEnd).map((line) => patchLine(" ", line)).join("");
  }).join("");
}

export async function previewRepairs(ctx, fix, { checker, inputs, temporaryRoot } = {}) {
  const overlays = inputs?.entries.map((entry) => entry.path) ?? [];
  const outsideInputs = (path) => !overlays.some((root) => isWithin(root, path));
  const selected = (ctx.allFiles ?? ctx.files).filter(outsideInputs);
  const extraFiles = [...(ctx.inputs?.keys() ?? [])].filter((path) => outsideInputs(path) && existsSync(safePath(ctx.root, path, { allowMissing: true })));
  const copied = copyWorkspace(ctx.root, { files: selected, extraFiles, temporaryRoot });
  try {
    const overlay = inputs ? materializeInputs(copied.root, inputs) : null;
    const beforeInventory = inventory(copied.root);
    if (beforeInventory.problems.length) throw new Error("The repair workspace contains unsupported paths");
    const before = new Map(beforeInventory.files.map((path) => {
      const target = safePath(copied.root, path);
      return [path, { bytes: readFileSync(target), mode: modeOf(target) }];
    }));
    const result = await fix(copied.root);
    const diagnostics = result?.diagnostics ?? [];
    if (!Array.isArray(diagnostics) || diagnostics.some((item) => item.status === "incomplete") || result?.status === "incomplete" || result?.exitCode === 2) throw new Error(`Repair preview could not complete: ${diagnostics.map((item) => item.message).join("; ") || "the fixer reported incomplete execution"}`);
    const after = inventory(copied.root);
    if (after.problems.length || canonical(after.files) !== canonical(beforeInventory.files)) throw new Error("Conservative repairs cannot add, remove or replace source paths");
    const changes = [];
    for (const path of beforeInventory.files) {
      const target = safePath(copied.root, path), original = before.get(path), bytes = readFileSync(target);
      if (modeOf(target) !== original.mode) throw new Error(`Conservative repairs cannot change file modes: ${path}`);
      if (bytes.equals(original.bytes)) continue;
      writable(ctx, path);
      if (!outsideInputs(path)) throw new Error(`Repairs cannot modify pinned input overlays: ${path}`);
      const previous = text(original.bytes, path), next = text(bytes, path);
      changes.push({ path, mode: original.mode, beforeSha256: digest(original.bytes), afterSha256: digest(bytes), before: previous, after: next });
    }
    copied.verify(); inputs?.verify(); overlay?.verify?.();
    return { schemaVersion: 1, kind: "plumb-repair", identity: { ...copied.identity, policy: digest(canonical(ctx.config)), ...(checker ? { checker } : {}), ...(inputs ? { inputs: inputs.identity } : {}) }, changes, patch: repairPatch(changes), diagnostics };
  } finally { copied.cleanup(); }
}

export function applyRepairs(ctx, plan, { checker, inputs, replaceFile = renameSync } = {}) {
  exactKeys(plan, ["schemaVersion", "kind", "identity", "changes", "patch", "diagnostics"], "repair plan");
  if (plan.schemaVersion !== 1 || plan.kind !== "plumb-repair" || !Array.isArray(plan.changes) || typeof plan.patch !== "string") throw new Error("Expected a version 1 Plumb repair plan");
  exactKeys(plan.identity, ["snapshot", "permissions", "policy", "checker", "inputs"], "repair identity");
  if (![plan.identity.snapshot, plan.identity.permissions, plan.identity.policy].every(sha) || plan.identity.policy !== digest(canonical(ctx.config))) throw new Error("Repair policy changed; generate and review a new plan");
  if (plan.identity.checker !== undefined && canonical(plan.identity.checker) !== canonical(checker)) throw new Error("Repair checker changed or is unavailable; generate a new plan");
  if (plan.identity.inputs !== undefined && canonical(plan.identity.inputs) !== canonical(inputs?.identity)) throw new Error("Repair inputs changed or are unavailable; generate a new plan");
  inputs?.verify();
  if (plan.diagnostics !== undefined && (!Array.isArray(plan.diagnostics) || plan.diagnostics.some((item) => item.status === "incomplete"))) throw new Error("An incomplete repair plan cannot be applied");
  const paths = new Set();
  const prepared = plan.changes.map((change) => {
    exactKeys(change, ["path", "mode", "beforeSha256", "afterSha256", "before", "after"], "repair change");
    const target = writable(ctx, change.path);
    if (paths.has(target)) throw new Error(`Duplicate repair path: ${change.path}`);
    paths.add(target);
    if (!Number.isInteger(change.mode) || change.mode < 0 || change.mode > 0o777 || !sha(change.beforeSha256) || !sha(change.afterSha256) || typeof change.before !== "string" || typeof change.after !== "string") throw new Error(`Malformed repair content: ${change.path}`);
    const before = Buffer.from(change.before), after = Buffer.from(change.after);
    if (text(before, change.path) !== change.before || text(after, change.path) !== change.after || digest(before) !== change.beforeSha256 || digest(after) !== change.afterSha256 || before.equals(after)) throw new Error(`Repair content integrity mismatch: ${change.path}`);
    if (!readFileSync(target).equals(before) || modeOf(target) !== change.mode) throw new Error(`Stale repair input: ${change.path}`);
    const token = randomUUID();
    return { ...change, target, before, after, staged: join(dirname(target), `.plumb-repair-${token}`), backup: join(dirname(target), `.plumb-backup-${token}`) };
  });
  if (plan.patch !== repairPatch(plan.changes)) throw new Error("Repair patch does not match its proposed changes");
  const replaced = [], temporary = [], preserve = new Set();
  try {
    for (const item of prepared) for (const [path, bytes] of [[item.staged, item.after], [item.backup, item.before]]) {
      writeFileSync(path, bytes, { flag: "wx", mode: item.mode }); temporary.push(path); chmodSync(path, item.mode);
    }
    for (const item of prepared) {
      writable(ctx, item.path);
      if (!readFileSync(item.target).equals(item.before) || modeOf(item.target) !== item.mode) throw new Error(`Stale repair input: ${item.path}`);
      replaced.push(item); replaceFile(item.staged, item.target);
    }
    return { written: prepared.map((item) => item.path) };
  } catch (error) {
    const failures = [];
    for (const item of replaced.reverse()) { try { renameSync(item.backup, item.target); } catch (failure) { preserve.add(item.backup); failures.push(`${item.path}: ${failure.message}; original saved at ${item.backup}`); } }
    if (failures.length) throw new Error(`${error.message}; rollback needs review: ${failures.join("; ")}`);
    throw error;
  } finally { for (const path of temporary) { try { if (!preserve.has(path)) rmSync(path, { force: true }); } catch {} } }
}
