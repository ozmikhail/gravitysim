import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import { scaffoldProposals } from "./conventions.mjs";
import { canonical, digest, isWithin, safePath } from "./files.mjs";
import { repairPatch } from "./repair.mjs";
import { copyWorkspace, inputDigest, materializeInputs } from "./workspace.mjs";

const patch = (files) => files.map(({ path, content }) => repairPatch([{ path, before: "", after: content }]).replace(/^--- .*$/m, "--- /dev/null")).join("");

// Creation is guarded by exclusive opens. Rollback removes only files this call still owns.
function createFiles(root, proposals, create = openSync) {
  const written = [], directories = [];
  const parents = (target) => {
    const pending = []; let path = dirname(target);
    while (!existsSync(path)) { pending.unshift(path); path = dirname(path); }
    for (const folder of pending) {
      safePath(root, relative(root, folder), { allowMissing: true });
      try { mkdirSync(folder); directories.push(folder); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  };
  try {
    for (const item of proposals) {
      const target = safePath(root, item.path, { allowMissing: true });
      parents(target);
      safePath(root, item.path, { allowMissing: true });
      const descriptor = create(target, "wx", 0o644);
      try {
        const stat = fstatSync(descriptor);
        const record = { path: item.path, target, device: stat.dev, inode: stat.ino, bytes: Buffer.from(item.content), complete: false };
        written.push(record);
        writeFileSync(descriptor, item.content, "utf8");
        record.complete = true;
      } finally { closeSync(descriptor); }
    }
    return written.map((item) => item.path);
  } catch (error) {
    const failures = [];
    for (const item of written.reverse()) {
      try {
        const stat = lstatSync(item.target);
        if (!stat.isFile() || stat.dev !== item.device || stat.ino !== item.inode) throw new Error("the created path was replaced concurrently");
        const current = readFileSync(item.target);
        if (item.complete ? !current.equals(item.bytes) : !item.bytes.subarray(0, current.length).equals(current)) throw new Error("the created content changed concurrently");
        unlinkSync(item.target);
      } catch (failure) { if (failure.code !== "ENOENT") failures.push(`${item.path}: ${failure.message}`); }
    }
    for (const directory of directories.reverse()) { try { rmdirSync(directory); } catch {} }
    if (failures.length) throw new Error(`${error.message}; scaffold rollback needs review: ${failures.join("; ")}`);
    throw error;
  }
}

export async function scaffold(ctx, execute, { role, name, dryRun = false, inputs, checker, verify, temporaryRoot, create } = {}) {
  const proposals = scaffoldProposals(ctx, { role, name });
  const overlays = inputs?.entries.map((entry) => entry.path) ?? [];
  const outside = (path) => !overlays.some((entry) => isWithin(entry, path));
  if (proposals.some((item) => !outside(item.path))) throw new Error("Scaffolds cannot create files inside approved input overlays");
  const extraFiles = [...(ctx.inputs?.keys() ?? [])].filter((path) => outside(path) && existsSync(safePath(ctx.root, path, { allowMissing: true })));
  const copied = copyWorkspace(ctx.root, { files: (ctx.allFiles ?? ctx.files).filter(outside), extraFiles, temporaryRoot });
  const stable = () => {
    copied.verify(); inputs?.verify();
    for (const input of ctx.policyInputs ?? []) if (digest(readFileSync(input.path)) !== input.sha256) throw new Error(`Scaffold policy input changed: ${input.path}`);
    if (canonical(scaffoldProposals(ctx, { role, name })) !== canonical(proposals)) throw new Error("Scaffold targets changed during validation");
    verify?.();
  };
  try {
    const overlay = inputs ? materializeInputs(copied.root, inputs) : undefined;
    createFiles(copied.root, proposals);
    const before = inputDigest(copied.root);
    const checked = await execute({ root: copied.root, policy: ctx.path, configFile: ctx.configFile, inputBundle: inputs, inputOverlay: overlay });
    if (inputDigest(copied.root) !== before) throw new Error("The scaffold checker changed its proposed source or inputs");
    overlay?.verify(); stable();
    if (!checked || !Array.isArray(checked.diagnostics) || !Array.isArray(checked.checks) || !["pass", "violation", "incomplete"].includes(checked.status) || checked.exitCode !== ({ pass: 0, violation: 1, incomplete: 2 })[checked.status]) throw new Error("Scaffold validation did not return a consistent checker report");
    const valid = checked.status === "pass" && checked.diagnostics.length === 0 && checked.checks.length > 0 && checked.checks.every((entry) => ["pass", "not-applicable"].includes(entry.status));
    if (checked.status === "pass" && !valid || checked.status !== "pass" && !checked.diagnostics.length) throw new Error("Scaffold validation status contradicts its check evidence");
    const plan = { schemaVersion: 1, kind: "plumb-scaffold", role, name, identity: { ...copied.identity, policy: digest(canonical(ctx.config)), ...(checker ? { checker } : {}), ...(inputs ? { inputs: inputs.identity } : {}) }, files: proposals.map((item) => ({ ...item, sha256: digest(item.content) })), patch: patch(proposals), validation: { status: checked.status, diagnostics: checked.diagnostics, identity: checked.identity } };
    if (dryRun || !valid) return { plan, checked, written: [] };
    stable();
    const written = createFiles(ctx.root, proposals, create);
    return { plan, checked, written };
  } finally { copied.cleanup(); }
}
