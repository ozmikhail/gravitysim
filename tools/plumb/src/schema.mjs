import { canonical, globMatches, normalize } from "./files.mjs";

export function validateSchema(value, shape, at = "config") {
  const bad = (message) => { throw new TypeError(`${at}: ${message}`); };
  if (Object.hasOwn(shape, "const") && value !== shape.const) bad(`must equal ${shape.const}`);
  if (shape.enum && !shape.enum.includes(value)) bad(`must be one of ${shape.enum.join(", ")}`);
  if (shape.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) bad("must be an object");
    for (const required of shape.required ?? []) if (!Object.hasOwn(value, required)) bad(`missing ${required}`);
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) bad(`unsupported key ${key}`);
      const sub = shape.properties?.[key] ?? (typeof shape.additionalProperties === "object" ? shape.additionalProperties : null);
      if (sub) validateSchema(item, sub, `${at}.${key}`);
      else if (shape.additionalProperties === false) bad(`unknown key ${key}`);
    }
  } else if (shape.type === "array") {
    if (!Array.isArray(value) || value.length < (shape.minItems ?? 0)) bad(`must be an array with at least ${shape.minItems ?? 0} entries`);
    if (shape.uniqueItems && new Set(value.map(canonical)).size !== value.length) bad("contains duplicate entries");
    value.forEach((item, index) => validateSchema(item, shape.items, `${at}[${index}]`));
  } else if (shape.type === "string") {
    if (typeof value !== "string" || value.length < (shape.minLength ?? 0) || value.includes("\0")) bad("must be a valid string");
    if (shape.pattern && !new RegExp(shape.pattern).test(value)) bad(`must match ${shape.pattern}`);
    if (shape.format === "regex") { try { new RegExp(value); } catch { bad("invalid regular expression"); } }
    if (shape.format === "glob") { try { globMatches(value, "probe"); } catch (error) { bad(error.message); } }
    if (shape.format === "path" && (/^(?:[a-z]:|\/)/i.test(normalize(value)) || normalize(value).split("/").some((part) => ["..", ".git", ".hg", ".svn", "node_modules"].includes(part)))) bad("must stay inside the repository and outside reserved metadata or dependency directories");
  } else if (shape.type === "boolean" && typeof value !== "boolean") bad("must be a boolean");
  else if (shape.type === "integer" && (!Number.isInteger(value) || value < (shape.minimum ?? 0) || value > (shape.maximum ?? Infinity))) bad("integer is outside its supported range");
}
