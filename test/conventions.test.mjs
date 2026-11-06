import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkConventions, planConventions, scaffoldProposals, validateConventions } from "../src/conventions.mjs";
import { globMatches, safePath } from "../src/files.mjs";

const layout = () => ({ files: ["src/**/*.ts"], roles: [
  { id: "service", files: ["src/*.service.ts"], name: "^[a-z]+\\.service\\.ts$", companions: [{ path: "{dir}/{stem}.test{ext}", role: "test" }],
    scaffold: { path: "src/{name}.service.ts", content: "export const {name} = 1;\n", companions: [{ path: "{dir}/{stem}.test{ext}", content: "const example = '{name}';\n" }] } },
  { id: "test", files: ["src/*.service.test.ts"] },
] });

function fixture(t, files = {}, conventions = layout(), options = {}) {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-conventions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  for (const [path, content] of Object.entries(files)) write(path, content);
  const config = { schemaVersion: 1, preset: "portable", projects: [], exclude: [], conventions, ...options };
  const selected = Object.keys(files).filter((path) => !config.exclude.some((entry) => globMatches(entry.files, path))).sort();
  return { root, config, configFile: "plumb.json", allFiles: Object.keys(files).sort(), files: selected, ownedFiles: [], protectedFiles: [],
    safePath: (path, options) => safePath(root, path, options), matches: globMatches, read: (path) => readFileSync(safePath(root, path), "utf8"), write };
}

test("each governed file has one role and companions use the same inventory", (t) => {
  const ctx = fixture(t, { "src/pay.service.ts": "export const pay = 1;", "src/pay.service.test.ts": "export {};", "README.md": "# Guide\n" });
  const plan = planConventions(ctx);
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(plan.roles, [{ id: "service", files: ["src/pay.service.ts"] }, { id: "test", files: ["src/pay.service.test.ts"] }]);
  assert.equal(plan.files.find((file) => file.path === "src/pay.service.ts").role, "service");
  assert.deepEqual(checkConventions(ctx, plan), []);
});

test("missing and ambiguous roles cannot be hidden behind a broad governed scope", (t) => {
  const value = { files: ["src/**"], roles: [{ id: "one", files: ["src/one.ts"] }, { id: "two", files: ["src/one.ts"] }] };
  const ctx = fixture(t, { "src/one.ts": "", "src/orphan.ts": "" }, value);
  const result = checkConventions(ctx);
  assert.equal(result.length, 2);
  assert.ok(result.every((item) => item.rule === "conventions.role" && item.suppressible === false));
  assert.match(result.find((item) => item.path === "src/one.ts").message, /multiple roles/);
  assert.match(result.find((item) => item.path === "src/orphan.ts").message, /no declared/);
});

test("every declared top-level and role glob must match selected governed sources", (t) => {
  const value = { files: ["src/**/*.ts", "missing/**"], roles: [{ id: "source", files: ["src/*.ts", "never/**"] }] };
  const ctx = fixture(t, { "src/main.ts": "" }, value);
  const result = checkConventions(ctx);
  assert.equal(result.length, 2);
  assert.ok(result.every((item) => item.rule === "conventions.scope" && item.status === "incomplete"));
  assert.ok(result.some((item) => item.message.includes("missing/**")));
  assert.ok(result.some((item) => item.message.includes("never/**")));
});

test("reasoned exclusions remain visible and cannot silently empty a role", (t) => {
  const value = { files: ["src/**"], roles: [{ id: "source", files: ["src/**"] }] };
  const ctx = fixture(t, { "src/main.ts": "", "src/vendor/code.ts": "" }, value, { exclude: [{ files: ["src/vendor/**"], reason: "Checked upstream" }] });
  const plan = planConventions(ctx);
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(plan.files.find((file) => file.path.includes("vendor")).reasons, ["Checked upstream"]);
  assert.equal(plan.files.find((file) => file.path.includes("vendor")).excluded, true);
  assert.deepEqual(plan.roles[0].files, ["src/main.ts"]);
  ctx.config.exclude.push({ files: ["src/main.ts"], reason: "Checked separately" });
  assert.ok(planConventions(ctx).diagnostics.some((item) => item.status === "incomplete"));
});

test("a governed inventory omission without an exclusion is incomplete", (t) => {
  const ctx = fixture(t, { "src/main.ts": "", "src/hidden.ts": "" }, { files: ["src/**"], roles: [{ id: "source", files: ["src/**"] }] });
  ctx.files = ["src/main.ts"];
  assert.ok(planConventions(ctx).diagnostics.some((item) => item.path === "src/hidden.ts" && item.status === "incomplete"));
});

test("role naming and missing or incorrectly owned companions produce concrete refusals", (t) => {
  const ctx = fixture(t, { "src/Bad.service.ts": "", "src/good.service.test.ts": "" });
  const result = checkConventions(ctx);
  assert.ok(result.some((item) => item.rule === "conventions.name" && item.path === "src/Bad.service.ts"));
  assert.ok(result.some((item) => item.rule === "conventions.companion" && /Bad\.service\.test\.ts/.test(item.message) && item.status === "violation"));
  const wrong = layout(); wrong.roles[0].companions[0].role = "service";
  const complete = fixture(t, { "src/pay.service.ts": "", "src/pay.service.test.ts": "" }, wrong);
  assert.ok(checkConventions(complete).some((item) => item.rule === "conventions.companion" && /must have role service/.test(item.message)));
});

test("deleted sources and excluded or linked companions never prove completion", (t) => {
  const ctx = fixture(t, { "src/pay.service.ts": "", "src/pay.service.test.ts": "", "src/other.service.test.ts": "" });
  rmSync(join(ctx.root, "src/pay.service.ts"));
  assert.ok(checkConventions(ctx).some((item) => item.rule === "conventions.scope" && item.status === "incomplete"));
  ctx.write("src/pay.service.ts", "");
  ctx.config.exclude = [{ files: ["src/pay.service.test.ts"], reason: "Separate test gate" }];
  assert.ok(checkConventions(ctx).some((item) => item.rule === "conventions.companion" && item.status === "incomplete"));
  ctx.config.exclude = [];
  rmSync(join(ctx.root, "src/pay.service.test.ts"));
  symlinkSync(join(ctx.root, "src/other.service.test.ts"), join(ctx.root, "src/pay.service.test.ts"));
  assert.ok(checkConventions(ctx).some((item) => item.status === "incomplete" && /Symbolic links/.test(item.message)));
});

test("one schema rejects unknown, contradictory and vacuous policy data", () => {
  const invalid = [
    { ...layout(), unknown: true },
    { files: [], roles: layout().roles },
    { files: ["**"], roles: [{ id: "source", files: ["**"] }, { id: "source", files: ["src/**"] }] },
    { files: ["**"], roles: [{ id: "source", files: ["**"], name: "[" }] },
    { files: ["**"], roles: [{ id: "source", files: ["**"], imports: { deny: [] } }] },
    { files: ["**"], roles: [{ id: "source", files: ["**"], exports: { require: ["x"], allow: [] } }] },
    { files: ["**"], roles: [{ id: "source", files: ["**"], companions: [{ path: "other.ts", role: "unknown" }] }] },
    { files: ["**"], roles: [{ id: "source", files: ["**"], javascript: { budgets: {} } }] },
    ...[{}, { min: 0 }, { min: 2, max: 1 }].map((count) => ({ files: ["**"], roles: [{ id: "source", files: ["**"], javascript: { nodes: [{ id: "shape", select: { kinds: ["function"] }, count }] } }] })),
  ];
  for (const value of invalid) assert.throws(() => validateConventions(value), undefined, JSON.stringify(value));
  const valid = layout();
  valid.roles[0].javascript = { budgets: { functionLines: 20, maxParameters: 0, maxNesting: 1, duplicateBlocks: { minStatements: 2, maxCopies: 1 } } };
  assert.equal(validateConventions(valid), valid);
});

test("role scaffolding proposes literal source plus companions without writing files", (t) => {
  const ctx = fixture(t);
  const proposals = scaffoldProposals(ctx, { role: "service", name: "charge" });
  assert.deepEqual(proposals, [
    { path: "src/charge.service.test.ts", content: "const example = 'charge';\n", role: "test" },
    { path: "src/charge.service.ts", content: "export const charge = 1;\n", role: "service" },
  ]);
  assert.deepEqual(readdirSync(ctx.root), []);
});

test("scaffold substitutions are bounded literals, not paths or expressions", (t) => {
  const ctx = fixture(t);
  for (const name of ["../escape", "nested/item", "a' + code + '", "x".repeat(65), "two words", "bad.name"]) assert.throws(() => scaffoldProposals(ctx, { role: "service", name }), /identifier-like/);
  const invalid = layout(); invalid.roles[0].scaffold.path = "../{name}.ts";
  assert.throws(() => validateConventions(invalid), /inside the repository/);
  invalid.roles[0].scaffold.path = "src/{unknown}.ts";
  assert.throws(() => validateConventions(invalid), /unknown substitutions/);
  invalid.roles[0].scaffold.path = "src/{name}.service.ts";
  invalid.roles[0].scaffold.content = "x".repeat(65537);
  assert.throws(() => validateConventions(invalid), /64 KiB/);
});

test("scaffolds cannot overwrite, collide, enter exclusions or violate role ownership", (t) => {
  const ctx = fixture(t, { "src/pay.service.ts": "keep me" });
  assert.throws(() => scaffoldProposals(ctx, { role: "service", name: "pay" }), /overwrite/);
  assert.equal(ctx.read("src/pay.service.ts"), "keep me");
  ctx.config.exclude = [{ files: ["src/new*"], reason: "Separate ownership" }];
  assert.throws(() => scaffoldProposals(ctx, { role: "service", name: "new" }), /governed source scope/);
  ctx.config.exclude = [];
  ctx.config.conventions.roles.push({ id: "overlap", files: ["src/**"] });
  assert.throws(() => scaffoldProposals(ctx, { role: "service", name: "new" }), /exactly its intended role/);
  ctx.config.conventions.roles.pop();
  ctx.config.conventions.roles[0].scaffold.companions[0].path = "{dir}/{stem}{ext}";
  assert.throws(() => scaffoldProposals(ctx, { role: "service", name: "new" }), /duplicate scaffold target/);
});

test("scaffolds cannot create policy, generated, API or linked-directory targets", (t) => {
  const ctx = fixture(t, {}, { files: ["**"], roles: [{ id: "source", files: ["**"], scaffold: { path: "plumb.json", content: "{}" } }] }, { generated: [{ path: "generated.ts", content: "owned" }] });
  ctx.protectedFiles = ["approved-policy.json"];
  for (const path of ["plumb.json", "generated.ts", "api.surface.json", "eslint.config.mjs", "approved-policy.json"]) {
    ctx.config.conventions.roles[0].scaffold.path = path;
    assert.throws(() => scaffoldProposals(ctx, { role: "source", name: "example" }), /protected policy/);
  }
  mkdirSync(join(ctx.root, "actual")); symlinkSync(join(ctx.root, "actual"), join(ctx.root, "linked"), "dir");
  ctx.config.conventions.roles[0].scaffold.path = "linked/{name}.ts";
  assert.throws(() => scaffoldProposals(ctx, { role: "source", name: "example" }), /Symbolic links/);
  assert.equal(existsSync(join(ctx.root, "actual/example.ts")), false);
});
