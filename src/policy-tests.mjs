import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assetsFor } from "./assets.mjs";
import { canonical, digest, normalize, safePath } from "./files.mjs";
import { copyWorkspace, inputDigest, materializeInputs } from "./workspace.mjs";

const string = { type: "string", minLength: 1 };
const id = { ...string, pattern: "^[a-z][a-z0-9-]*$" };
const path = { ...string, format: "path" };
const array = (items, minItems = 0) => ({ type: "array", items, minItems, uniqueItems: true });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const contents = { type: "string" };
const file = object({ path, content: contents }, ["path", "content"]);
const edit = object({ path, content: contents, delete: { const: true } }, ["path"]);
const expectation = object({ rule: string, path, count: { type: "integer", minimum: 1 } }, ["rule"]);
export const POLICY_TESTS_SCHEMA = array(object({
  id, files: array(file, 1), cases: array(object({
    id, edits: array(edit, 1), expect: object({ status: { enum: ["pass", "violation"] }, diagnostics: array(expectation, 1) }, ["status"]),
  }, ["id", "edits", "expect"]), 1),
}, ["id", "files", "cases"]), 1);
export const RULES = [
  ["policy-tests.failed", "Policy examples and intentional violations produce exactly their approved outcomes."],
  ["policy-tests.incomplete", "Policy tests need a valid passing baseline and completed actual checks."],
].map(([id, description]) => ({ id, description, remedy: "Repair the policy fixture or its checker; unrelated failures cannot prove convention enforcement.", suppressible: false }));

export function validatePolicyTests(groups = [], configFile = "plumb.json") {
  const ids = new Set(); let cases = 0, bytes = 0;
  if (groups.length > 32) throw new Error("At most 32 policy fixture groups are supported");
  const validateFiles = (entries, editing = false) => {
    const paths = new Set();
    for (const entry of entries) {
      if (normalize(entry.path) !== entry.path || entry.path === "." || entry.path === configFile || entry.path === "plumb.json") throw new Error(`Invalid or policy-replacing fixture path: ${entry.path}`);
      if (paths.has(entry.path)) throw new Error(`Duplicate fixture path: ${entry.path}`);
      paths.add(entry.path);
      if (editing && (Object.hasOwn(entry, "content") === Object.hasOwn(entry, "delete"))) throw new Error("A fixture edit requires exactly one content or delete operation");
      bytes += Buffer.byteLength(entry.content ?? "");
    }
  };
  for (const group of groups) {
    if (ids.has(group.id)) throw new Error(`Duplicate policy fixture ${group.id}`); ids.add(group.id);
    validateFiles(group.files);
    const names = new Set();
    for (const example of group.cases) {
      if (++cases > 128) throw new Error("At most 128 policy examples are supported");
      if (example.id === "baseline") throw new Error("The baseline example id is reserved");
      if (names.has(example.id)) throw new Error(`Duplicate policy example ${group.id}/${example.id}`); names.add(example.id);
      validateFiles(example.edits, true);
      if (example.expect.status === "pass" && example.expect.diagnostics || example.expect.status === "violation" && !example.expect.diagnostics?.length) throw new Error("Passing examples have no findings; refusing examples name their exact expected diagnostics");
      const expected = example.expect.diagnostics ?? [];
      for (const [index, row] of expected.entries()) if (expected.slice(0, index).some((other) => other.rule === row.rule && (!other.path || !row.path || other.path === row.path))) throw new Error(`Overlapping diagnostic expectations in ${group.id}/${example.id}`);
    }
  }
  if (bytes > 8 * 1024 * 1024) throw new Error("Policy fixture source exceeds 8 MiB");
}

const issue = (group, message, incomplete = false) => ({ rule: incomplete ? "policy-tests.incomplete" : "policy-tests.failed", path: "plumb.json", message: `${group.id}: ${message}`, remedy: "Run policy-test and correct the fixture or convention; expected rules must reject the intended source deviation.", ...(incomplete ? { status: "incomplete" } : {}), suppressible: false, check: `policy-test:${group.id}` });

function compareOutcome(result, expected) {
  if (!result || !Array.isArray(result.diagnostics) || !Array.isArray(result.checks) || !result.checks.length || result.checks.some((check) => !["pass", "violation", "not-applicable"].includes(check.status)) || !["pass", "violation"].includes(result.status) || result.exitCode !== (result.status === "pass" ? 0 : 1) || result.status === "pass" && (result.diagnostics.length > 0 || result.checks.some((check) => check.status === "violation")) || result.status === "violation" && !result.diagnostics.length) throw new Error("The fixture check did not complete consistently; a parser, tool or prerequisite failure is not an expected refusal");
  if (result.status !== expected.status) return `Expected ${expected.status}, received ${result.status}`;
  const rows = expected.diagnostics ?? [], remaining = rows.map((row) => row.count ?? 1);
  for (const item of result.diagnostics) {
    if (item.status === "incomplete") throw new Error("An incomplete diagnostic cannot prove a policy violation");
    const index = rows.findIndex((row) => row.rule === item.rule && (!row.path || row.path === item.path));
    if (index < 0 || --remaining[index] < 0) return `Unexpected diagnostic ${item.rule} at ${item.path}`;
  }
  if (remaining.some(Boolean)) return `Expected diagnostics were not produced: ${rows.filter((_row, index) => remaining[index]).map((row) => `${row.rule}${row.path ? ` at ${row.path}` : ""}`).join(", ")}`;
}

// Each case starts from identical approved data, never from a previous mutation's output.
export async function runPolicyTests(ctx, execute, { inputs, temporaryRoot } = {}) {
  const groups = ctx.config.policyTests ?? [], diagnostics = [], checks = [], results = [];
  validatePolicyTests(groups, ctx.configFile);
  const candidatePolicy = ctx.read?.(ctx.configFile ?? "plumb.json", { allowMissing: true }) ?? ctx.source ?? `${JSON.stringify(ctx.config, null, 2)}\n`;
  for (const group of groups) {
    const evidence = { id: group.id, status: "pass", cases: [] };
    const runCase = async (example) => {
      const workspace = copyWorkspace(ctx.root, { files: [], temporaryRoot });
      try {
        const policy = join(dirname(workspace.root), "approved-policy.json"), policyBytes = JSON.stringify(ctx.config) + "\n";
        writeFileSync(policy, policyBytes, { flag: "wx", mode: 0o600 });
        const initial = new Map(assetsFor(ctx.config).map((asset) => [asset.path, asset]));
        initial.set(ctx.configFile ?? "plumb.json", { path: ctx.configFile ?? "plumb.json", content: candidatePolicy });
        for (const entry of group.files) initial.set(entry.path, entry);
        for (const entry of initial.values()) {
          const target = safePath(workspace.root, entry.path, { allowMissing: true });
          mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, entry.content, { flag: "wx" });
          chmodSync(target, entry.executable ? 0o755 : 0o644);
        }
        for (const edit of example.edits ?? []) {
          const target = safePath(workspace.root, edit.path, { allowMissing: true });
          if (edit.delete) { if (!existsSync(target)) throw new Error(`Cannot delete absent fixture input ${edit.path}`); rmSync(target); }
          else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, edit.content); }
        }
        const overlay = inputs ? materializeInputs(workspace.root, inputs) : undefined;
        const before = inputDigest(workspace.root);
        const result = await execute({ root: workspace.root, policy, configFile: ctx.configFile, inputBundle: inputs, inputOverlay: overlay });
        if (inputDigest(workspace.root) !== before || readFileSync(policy, "utf8") !== policyBytes) throw new Error("The policy test checker changed its fixture or approved policy");
        overlay?.verify(); inputs?.verify(); workspace.verify();
        const mismatch = compareOutcome(result, example.expect);
        const caseEvidence = { id: example.id, status: mismatch ? "violation" : "pass", expected: example.expect.status, actual: result.status, snapshot: before, policy: digest(canonical(ctx.config)), checker: result.identity?.checker, diagnostics: result.diagnostics.map(({ rule, path, status }) => ({ rule, path, status: status ?? "violation" })), ...(mismatch ? { message: mismatch } : {}) };
        evidence.cases.push(caseEvidence);
        return mismatch;
      } finally { workspace.cleanup(); }
    };
    try {
      const baseline = await runCase({ id: "baseline", expect: { status: "pass" } });
      if (baseline) throw new Error(`The unmodified baseline must pass: ${baseline}`);
      for (const example of group.cases) {
        try {
          const mismatch = await runCase(example);
          if (mismatch) { diagnostics.push(issue(group, `${example.id}: ${mismatch}`)); if (evidence.status !== "incomplete") evidence.status = "violation"; }
        } catch (error) { diagnostics.push(issue(group, `${example.id}: ${error.message}`, true)); evidence.status = "incomplete"; evidence.cases.push({ id: example.id, status: "incomplete", message: error.message }); }
      }
    } catch (error) { diagnostics.push(issue(group, error.message, true)); evidence.status = "incomplete"; }
    results.push(evidence); checks.push({ id: `policy-test:${group.id}`, capability: "policy-tests", status: evidence.status, evidence: "actual-checker-fixtures" });
  }
  return { diagnostics, checks, results };
}
