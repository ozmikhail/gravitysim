import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { validateSchema } from "./config.mjs";
import { canonical, digest, safePath } from "./files.mjs";

const text = { type: "string", minLength: 1, pattern: "\\S" };
const identifier = { ...text, pattern: "^[a-z][a-z0-9._:-]*$" };
const list = (items) => ({ type: "array", items, minItems: 1, uniqueItems: true });
const names = list({ ...text, pattern: "^[a-z][a-z0-9._:/-]*$" });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const TASK_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: "urn:plumb:task:v1", title: "Plumb task contract",
  ...object({
    $schema: text, schemaVersion: { const: 1 }, id: identifier, requireChecks: names, requireTests: names,
  }, ["schemaVersion", "id"]),
};
export const RULES = [
  ["task.checks", "Every required check must complete successfully."],
  ["task.tests", "Every required test suite must provide complete execution evidence."],
  ["task.changed", "The approved task contract cannot change during a run."],
].map(([id, description]) => ({ id, description, remedy: "Resolve the source or verification failure; changes to the task contract need their own review.", suppressible: false }));

const problem = (rule, path, message, status = "violation") => ({ rule, path, message, status, suppressible: false, remedy: "Satisfy the approved task contract and rerun the complete check; project exceptions cannot waive task restrictions." });
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const unique = (values) => [...new Set(values)].sort();

export function defineTask(input) {
  validateSchema(input, TASK_SCHEMA, "task");
  return freeze(structuredClone(input));
}

export function loadTask(path, { root } = {}) {
  const absolute = resolve(path), target = safePath(dirname(absolute), basename(absolute));
  if (root) {
    const offset = relative(realpathSync(root), realpathSync(target));
    if (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)) throw new TypeError("The approved task contract must be outside the candidate repository");
  }
  const source = readFileSync(target, "utf8"), task = defineTask(JSON.parse(source));
  return { task, path: target, source, identity: { id: task.id, sha256: digest(source) } };
}

export function taskRequirements(task) {
  return { checks: unique(task.requireChecks ?? []), tests: unique(task.requireTests ?? []) };
}

export function checkTask(loaded, { checks = [], testResults = [], subject } = {}) {
  const task = loaded.task ?? loaded, requirements = taskRequirements(task), diagnostics = [];
  if (loaded.path) {
    try { if (readFileSync(loaded.path, "utf8") !== loaded.source) throw new Error("The approved task file changed while checking"); }
    catch (error) { diagnostics.push(problem("task.changed", ".", error.message, "incomplete")); }
  }
  for (const name of requirements.checks) {
    const matching = checks.filter((check) => check.id === name || check.capability === name || check.capabilities?.includes(name));
    const unfinished = !matching.length || matching.some((check) => !["pass", "violation"].includes(check.status));
    if (unfinished || matching.some((check) => check.status !== "pass")) diagnostics.push(problem("task.checks", ".", `Required check ${name} did not complete successfully for every applicable scope.`, unfinished ? "incomplete" : "violation"));
  }
  for (const name of requirements.tests) {
    const matching = testResults.filter((result) => result.id === name), result = matching[0];
    const counts = result && [result.tests, result.passed, result.failed, result.skipped];
    const complete = matching.length === 1 && counts.every((count) => Number.isInteger(count) && count >= 0) && result.tests === result.passed + result.failed + result.skipped && result.passed + result.failed > 0 && ["pass", "violation"].includes(result.status) && (!subject || canonical(result.subject) === canonical(subject));
    if (!complete || result.status !== "pass" || result.failed) diagnostics.push(problem("task.tests", ".", `Required test suite ${name} needs complete, nonempty execution evidence for this checked subject.`, !complete || result.status === "pass" && result.failed ? "incomplete" : "violation"));
  }
  return { diagnostics, requirements };
}
