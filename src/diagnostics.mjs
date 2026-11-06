import { canonical, digest, normalize } from "./files.mjs";

function action(item) {
  if (/^(?:tools\.|adapters?\.(?:missing|version)|verification\.incomplete)/.test(item.rule)) return { kind: "resolve-prerequisite", argv: ["plumb", "doctor"], message: item.remedy };
  if (/^(?:exceptions\.|bundle\.|lock\.)/.test(item.rule)) return { kind: "review-policy", message: item.remedy };
  if (/^generated\./.test(item.rule)) return { kind: "sync-assets", argv: ["plumb", "sync"], message: item.remedy };
  if (/format/.test(item.rule) && item.status !== "incomplete") return { kind: "preview-repair", argv: ["plumb", "fix", "--dry-run"], message: item.remedy };
  return { kind: item.status === "incomplete" ? "resolve-input" : "edit-source", files: [item.path], message: item.remedy };
}

export function enrichDiagnostics(items) {
  const seen = new Map();
  return items.map((item) => {
    const key = canonical([item.rule, normalize(item.path ?? "."), item.fingerprintHint ?? item.message]);
    const occurrence = (seen.get(key) ?? 0) + 1; seen.set(key, occurrence);
    return { ...item, fingerprint: item.fingerprint ?? digest(canonical([key, occurrence])), actions: item.actions ?? [action(item)], relatedLocations: item.relatedLocations ?? [] };
  });
}

export function policyPointer(rule) {
  if (rule.startsWith("files.")) return rule === "files.names" ? "/files/names" : "/files";
  if (rule.startsWith("docs.")) return "/docs";
  if (rule.startsWith("generated.")) return "/generated";
  if (rule.startsWith("exceptions.")) return "/exceptions";
  if (rule.startsWith("javascript/")) return "/javascript";
  if (rule.startsWith("javascript.")) return "/contracts";
  if (rule.startsWith("verification.")) return "/verification";
  if (rule.startsWith("policy-tests.")) return "/policyTests";
  if (rule.startsWith("conventions.")) return "/conventions";
  if (rule.startsWith("policy.")) return "/policy";
  if (/^(?:ruby|cpp|projects|adapters?)\./.test(rule)) return "/projects";
  return "";
}

export function attachOrigins(items, origins = {}) {
  return items.map((item) => {
    const pointer = item.policyPointer ?? policyPointer(item.rule);
    let selected = origins[pointer];
    if (!selected) selected = Object.entries(origins).filter(([path]) => path.startsWith(`${pointer}/`)).flatMap(([, values]) => values);
    return { ...item, policyOrigins: [...new Map((selected ?? []).map((origin) => [canonical(origin), origin])).values()] };
  });
}

const uri = (path) => normalize(path).split("/").map(encodeURIComponent).join("/");
const location = (item) => ({ physicalLocation: { artifactLocation: { uri: uri(item.path ?? "."), uriBaseId: "%SRCROOT%" }, ...(item.line ? { region: { startLine: item.line, ...(item.column ? { startColumn: item.column } : {}) } } : {}) } });

export function toSarif(result) {
  const diagnostics = [...(result.diagnostics ?? []), ...(result.suppressed ?? [])];
  const rules = [...new Set(diagnostics.map((item) => item.rule))].sort();
  return {
    version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: { name: "Plumb", rules: rules.map((id) => ({ id, shortDescription: { text: id } })) } },
      invocations: [{ executionSuccessful: result.status !== "incomplete", toolExecutionNotifications: diagnostics.filter((item) => item.status === "incomplete").map((item) => ({ descriptor: { id: item.rule }, level: "error", message: { text: item.message } })) }],
      results: diagnostics.filter((item) => item.status !== "incomplete").map((item) => ({
        ruleId: item.rule, ruleIndex: rules.indexOf(item.rule), level: "error", message: { text: item.message }, locations: [location(item)],
        partialFingerprints: { "plumb/v1": item.fingerprint ?? digest(canonical([item.rule, item.path, item.message])) },
        ...(item.relatedLocations?.length ? { relatedLocations: item.relatedLocations.map((related, index) => ({ id: index + 1, ...location(related), ...(related.message ? { message: { text: related.message } } : {}) })) } : {}),
        ...(item.exception ? { suppressions: [{ kind: "external", status: "accepted", justification: `Reviewed exception ${item.exception}` }] } : {}),
        properties: { actions: item.actions ?? [], policyOrigins: item.policyOrigins ?? [] },
      })),
      properties: { status: result.status, identity: result.identity, coverage: result.coverage },
    }],
  };
}
