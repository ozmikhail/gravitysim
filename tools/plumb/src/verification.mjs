import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, digest, isWithin, safePath } from "./files.mjs";
import { run } from "./process.mjs";
import { copyWorkspace, inputDigest, materializeInputs } from "./workspace.mjs";

export const RULES = [
  ["verification.failed", "Required behavioral verification must pass."],
  ["verification.incomplete", "Required suites need fresh, complete execution evidence."],
  ["verification.skipped", "Skipped tests must stay within the reviewed suite budget."],
].map(([id, description]) => ({ id, description, remedy: "Restore the required tests and run the approved suite against the same source snapshot.", suppressible: false }));
const issue = (rule, suite, message, incomplete = false) => ({ rule, path: suite.cwd ?? ".", message, remedy: "Correct the suite, its prerequisites, or its report; verification cannot be replaced with a successful empty command.", ...(incomplete ? { status: "incomplete" } : {}), suppressible: false, check: `test:${suite.id}` });

function decode(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(value)) throw new Error("Unknown XML entity in test report");
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_all, entity) => {
    if (!entity.startsWith("#")) return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity.toLowerCase()];
    const point = Number.parseInt(entity.slice(entity[1].toLowerCase() === "x" ? 2 : 1), entity[1].toLowerCase() === "x" ? 16 : 10);
    if (!point || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw new Error("Invalid XML character");
    return String.fromCodePoint(point);
  });
}

// This bounded parser accepts the JUnit report vocabulary, with no DTDs or external entities.
export function parseJUnit(source) {
  if (Buffer.byteLength(source) > 16 * 1024 * 1024) throw new Error("Verification report exceeds 16 MiB");
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("DTD and entity declarations are not accepted in test reports");
  const stack = [], roots = []; let offset = 0, nodes = 0;
  const appendText = (text, raw = false) => {
    if (!stack.length) { if (text.trim()) throw new Error("Text outside the JUnit document"); return; }
    stack.at(-1).text += raw ? text : decode(text);
  };
  while (offset < source.length) {
    if (source[offset] !== "<") { const end = source.indexOf("<", offset); appendText(source.slice(offset, end < 0 ? source.length : end)); offset = end < 0 ? source.length : end; continue; }
    if (source.startsWith("<!--", offset) || source.startsWith("<![CDATA[", offset) || source.startsWith("<?xml", offset)) {
      const cdata = source.startsWith("<![CDATA[", offset), comment = source.startsWith("<!--", offset);
      const close = cdata ? "]]>" : comment ? "-->" : "?>", start = offset + (cdata ? 9 : comment ? 4 : 5), end = source.indexOf(close, start);
      if (end < 0) throw new Error("Unclosed XML section");
      if (cdata) appendText(source.slice(start, end), true);
      else if (!comment && (roots.length || stack.length)) throw new Error("Misplaced XML declaration");
      offset = end + close.length; continue;
    }
    let end = offset + 1, quote;
    for (; end < source.length; end++) { const char = source[end]; if (quote) { if (char === quote) quote = undefined; } else if (char === '"' || char === "'") quote = char; else if (char === ">") break; }
    if (end === source.length) throw new Error("Unclosed XML tag");
    const token = source.slice(offset + 1, end), close = /^\/\s*([\w:.-]+)\s*$/.exec(token);
    offset = end + 1;
    if (close) { if (!stack.length || stack.pop().tag !== close[1]) throw new Error("Mismatched JUnit closing tag"); continue; }
    const opened = /^([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)$/.exec(token);
    if (!opened) throw new Error("Invalid JUnit tag");
    const [, tag, raw, empty] = opened, name = tag.split(":").at(-1), attrs = {}; let rest = raw;
    while (rest.trim()) {
      const attribute = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      if (!attribute || ["__proto__", "constructor", "prototype"].includes(attribute[1]) || Object.hasOwn(attrs, attribute[1])) throw new Error("Malformed or duplicate JUnit attribute");
      attrs[attribute[1]] = decode(attribute[2] ?? attribute[3]); rest = rest.slice(attribute[0].length);
    }
    if (++nodes > 100000 || stack.length > 128) throw new Error("JUnit report exceeds structural limits");
    const node = { tag, name, attrs, children: [], text: "" }, parent = stack.at(-1);
    const allowed = parent ? { testsuites: ["testsuite", "testcase", "properties", "system-out", "system-err"], testsuite: ["testsuite", "testcase", "properties", "system-out", "system-err"], testcase: ["failure", "error", "skipped", "properties", "system-out", "system-err"], properties: ["property"] }[parent.name] ?? [] : ["testsuites", "testsuite"];
    if (!allowed.includes(name)) throw new Error(`Unsupported JUnit element ${name}`);
    if (parent) parent.children.push(node); else roots.push(node);
    if (!empty) stack.push(node);
  }
  if (stack.length || roots.length !== 1) throw new Error("Incomplete JUnit document");
  const cases = [];
  const visit = (node, parents = []) => {
    if (node.name === "testcase") {
      if (!node.attrs.name) throw new Error("JUnit test case needs a name");
      if (node.attrs.status && !["run", "passed", "failed", "skipped", "notrun", "disabled"].includes(node.attrs.status)) throw new Error("Unsupported JUnit test status");
      const failed = node.children.some((child) => ["failure", "error"].includes(child.name)) || node.attrs.status === "failed";
      const skipped = node.children.some((child) => child.name === "skipped") || ["skipped", "notrun", "disabled"].includes(node.attrs.status);
      if (failed && skipped) throw new Error("JUnit case cannot be both failed and skipped");
      const status = failed ? "failed" : skipped ? "skipped" : "passed";
      cases.push({ id: [...parents, node.attrs.file, node.attrs.classname, node.attrs.name].filter(Boolean).join("/"), status, ...(failed ? { message: node.children.filter((child) => ["failure", "error"].includes(child.name)).map((child) => child.attrs.message ?? child.text).join("\n").slice(0, 8192) } : {}) });
      return;
    }
    const start = cases.length;
    for (const child of node.children) visit(child, [...parents, ...(node.name === "testsuite" && node.attrs.name ? [node.attrs.name] : [])]);
    if (!["testsuite", "testsuites"].includes(node.name)) return;
    const rows = cases.slice(start), counts = { tests: rows.length, skipped: rows.filter((row) => row.status === "skipped").length };
    for (const [key, expected] of Object.entries(counts)) if (node.attrs[key] !== undefined && (!/^\d+$/.test(node.attrs[key]) || Number(node.attrs[key]) !== expected)) throw new Error(`JUnit ${key} count contradicts its test cases`);
    if (["failures", "errors"].some((key) => node.attrs[key] !== undefined)) {
      for (const key of ["failures", "errors"]) if (node.attrs[key] !== undefined && !/^\d+$/.test(node.attrs[key])) throw new Error("Invalid JUnit failure count");
      if (Number(node.attrs.failures ?? 0) + Number(node.attrs.errors ?? 0) !== rows.filter((row) => row.status === "failed").length) throw new Error("JUnit failure counts contradict its test cases");
    }
  };
  visit(roots[0]);
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("Duplicate JUnit test case identity");
  return cases;
}

export function parseVerification(source, format, id) {
  if (Buffer.byteLength(source) > 16 * 1024 * 1024) throw new Error("Verification report exceeds 16 MiB");
  if (format === "junit") return parseJUnit(source);
  if (format !== "plumb-json") throw new Error(`Unsupported verification format ${format}`);
  const value = JSON.parse(source);
  if (!value || value.schemaVersion !== 1 || value.suite !== id || !Array.isArray(value.tests) || Object.keys(value).some((key) => !["schemaVersion", "suite", "tests"].includes(key))) throw new Error("Expected a versioned report for the required suite");
  const ids = new Set();
  for (const row of value.tests) {
    if (!row || typeof row.id !== "string" || !row.id.trim() || ids.has(row.id) || !["passed", "failed", "skipped"].includes(row.status) || Object.keys(row).some((key) => !["id", "status", "message"].includes(key)) || row.message !== undefined && typeof row.message !== "string") throw new Error("Malformed, duplicate or unsupported test case");
    ids.add(row.id);
  }
  return value.tests;
}

function readReport(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1) throw new Error("A fresh report must be a regular file, not a link");
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > 16 * 1024 * 1024) throw new Error("Verification report is unsafe, changed or larger than 16 MiB");
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
  } finally { closeSync(file); }
}

export async function verifySuites(ctx, { subject, inputs, execute = run, temporaryRoot } = {}) {
  const diagnostics = [], results = [], checks = [];
  for (const suite of ctx.config.verification ?? []) {
    let workspace, artifacts, overlay;
    try {
      const files = ctx.allFiles.filter((path) => !inputs?.entries.some((entry) => isWithin(entry.path, path)));
      workspace = copyWorkspace(ctx.root, { files, temporaryRoot });
      if (inputs) overlay = materializeInputs(workspace.root, inputs);
      const temporary = temporaryRoot ?? process.env.PLUMB_TEST_TMP ?? tmpdir();
      mkdirSync(temporary, { recursive: true });
      artifacts = mkdtempSync(join(temporary, "plumb-results-"));
      const artifactsStat = lstatSync(artifacts), artifactsPath = realpathSync(artifacts);
      const reportPath = join(artifacts, suite.format === "junit" ? "report.xml" : "report.json");
      if (existsSync(reportPath)) throw new Error("Verification report already exists before execution");
      const env = { ...Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", ...(suite.inheritEnv ?? [])].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])), ...suite.env, PLUMB_REPORT: reportPath, PLUMB_ARTIFACTS: artifacts, PYTHONDONTWRITEBYTECODE: "1" };
      const command = suite.command.map((arg) => arg.replaceAll("{report}", reportPath).replaceAll("{artifacts}", artifacts));
      const before = inputDigest(workspace.root);
      const result = await execute(command, { cwd: safePath(workspace.root, suite.cwd ?? "."), timeout: suite.timeout ?? ctx.config.tools?.timeout ?? 120000, env, inheritEnv: false, maxOutput: 16 * 1024 * 1024 });
      if (result.error || result.code === null || result.code > 1 || result.code < 0) throw new Error(result.error ?? `Suite exited ${result.code}`);
      if (inputDigest(workspace.root) !== before) throw new Error("Suite changed checked source or approved inputs; direct generated output to {artifacts}");
      overlay?.verify(); inputs?.verify(); workspace.verify();
      const actualArtifacts = lstatSync(artifacts);
      if (!actualArtifacts.isDirectory() || actualArtifacts.dev !== artifactsStat.dev || actualArtifacts.ino !== artifactsStat.ino || realpathSync(artifacts) !== artifactsPath) throw new Error("Verification artifact directory was replaced");
      const source = (suite.report ?? "stdout") === "file" ? readReport(reportPath) : result.stdout;
      const tests = parseVerification(source, suite.format, suite.id), passed = tests.filter((test) => test.status === "passed").length, failed = tests.filter((test) => test.status === "failed").length, skipped = tests.length - passed - failed;
      if (passed + failed < (suite.minTests ?? 1)) throw new Error(`Only ${passed + failed} tests executed; at least ${suite.minTests ?? 1} are required`);
      if (result.code === 1 && !failed) throw new Error("Failing command contradicts a report without failures");
      const status = failed || skipped > (suite.maxSkipped ?? 0) ? "violation" : "pass";
      const evidence = { id: suite.id, status, tests: tests.length, passed, failed, skipped, subject, reportSha256: digest(source), commandSha256: digest(canonical(suite.command)), environmentSha256: digest(canonical(Object.fromEntries(Object.entries(env).filter(([key]) => !["PLUMB_REPORT", "PLUMB_ARTIFACTS"].includes(key))))) };
      results.push(evidence); checks.push({ id: `test:${suite.id}`, capability: "tests", status, evidence: "test-report" });
      if (failed) diagnostics.push(issue("verification.failed", suite, `${failed} tests failed: ${tests.filter((test) => test.status === "failed").slice(0, 10).map((test) => `${test.id}${test.message ? `: ${test.message}` : ""}`).join("; ")}`));
      if (skipped > (suite.maxSkipped ?? 0)) diagnostics.push(issue("verification.skipped", suite, `${skipped} tests skipped; policy permits ${suite.maxSkipped ?? 0}.`));
    } catch (error) {
      diagnostics.push(issue("verification.incomplete", suite, `${suite.id}: ${error.message}`, true));
      results.push({ id: suite.id, status: "incomplete", subject }); checks.push({ id: `test:${suite.id}`, capability: "tests", status: "incomplete" });
    } finally { workspace?.cleanup(); if (artifacts) rmSync(artifacts, { recursive: true, force: true }); }
  }
  return { diagnostics, results, checks };
}
