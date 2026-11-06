import { globMatches } from "../shared/glob.mjs";
import { rulesRelativeTo } from "./rules/shared.mjs";

// every applicable row gets its own rule state; overlapping contracts are all enforced
export const scopedRule = (rule, root) => ({
  ...rule,
  meta: {
    ...rule.meta,
    schema: [{ type: "array", items: { type: "object", properties: { files: { type: "array", items: { type: "string" } }, options: { type: "array", maxItems: 1 } }, required: ["files", "options"], additionalProperties: false } }],
  },
  create(context) {
    const file = rulesRelativeTo(root, context.filename);
    const visitors = {};
    for (const row of context.options[0]) {
      if (!globMatches(row.files, file)) continue;
      const view = Object.create(context);
      Object.defineProperty(view, "options", { value: row.options });
      for (const [selector, visitor] of Object.entries(rule.create(view))) {
        const previous = visitors[selector];
        visitors[selector] = (...args) => { previous?.(...args); visitor(...args); };
      }
    }
    return visitors;
  },
});
