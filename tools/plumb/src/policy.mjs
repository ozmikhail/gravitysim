import { globMatches } from "./files.mjs";
export { isPolicyFile } from "./files.mjs";

export const RULES = [
  ["exceptions.invalid", "Exceptions must target known, suppressible rules."],
  ["exceptions.stale", "Remove exceptions and excess budgets that are no longer needed."],
  ["exceptions.overlap", "Each diagnostic must have one exception owner."],
  ["exceptions.expired", "Expired exceptions cannot hide a failure."],
].map(([id, description]) => ({ id, description, remedy: "Review the policy change with its owner before adopting a new approved policy.", suppressible: false }));
const problem = (rule, path, message, remedy, status = "violation") => ({ rule, path, message, remedy, status, suppressible: false });

export function applyExceptions(diagnostics, exceptions, metadata, date = new Date().toISOString().slice(0, 10)) {
  const visible = [], suppressed = [], issues = [], used = new Map(exceptions.map((entry) => [entry.id, 0]));
  const rules = new Map(metadata.map((rule) => [rule.id, rule]));
  const valid = exceptions.filter((entry) => {
    const invalid = entry.rules.filter((rule) => !rules.has(rule) || rules.get(rule).suppressible === false);
    if (invalid.length) issues.push(problem("exceptions.invalid", "plumb.json", `${entry.id} targets unknown or protected rules: ${invalid.join(", ")}.`, "Use exact rule IDs from plumb inspect; enforcement failures cannot be excepted."));
    if (entry.expires && entry.expires < date) issues.push(problem("exceptions.expired", "plumb.json", `Exception ${entry.id} expired on ${entry.expires}.`, "Fix the remaining violations and remove the expired exception."));
    return !invalid.length && (!entry.expires || entry.expires >= date);
  });
  for (const diagnostic of diagnostics) {
    const matches = valid.filter((entry) => entry.rules.includes(diagnostic.rule) && globMatches(entry.files, diagnostic.path));
    if (matches.length > 1) {
      issues.push(problem("exceptions.overlap", diagnostic.path, `Exceptions ${matches.map((entry) => entry.id).join(", ")} overlap.`, "Give this violation one narrow, bounded exception."));
      visible.push(diagnostic);
    } else if (matches.length && diagnostic.status !== "incomplete" && diagnostic.suppressible !== false) {
      const entry = matches[0], count = used.get(entry.id) + 1;
      used.set(entry.id, count);
      if (count <= entry.max) suppressed.push({ ...diagnostic, exception: entry.id });
      else visible.push(diagnostic);
    } else visible.push(diagnostic);
  }
  for (const entry of valid) {
    const count = used.get(entry.id);
    if (count < entry.max) issues.push(problem("exceptions.stale", "plumb.json", count === 0 ? `Exception ${entry.id} is no longer used.` : `Exception ${entry.id} needs ${count}, but budgets ${entry.max}.`, count === 0 ? "Remove this exception." : `Reduce max to ${count}; exception budgets only shrink.`));
  }
  return { diagnostics: [...visible, ...issues], suppressed };
}
