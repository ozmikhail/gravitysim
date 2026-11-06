import path from "node:path";

export const rulesRelativeTo = (root, filename) =>
  path.relative(root, filename).split(path.sep).join("/");

export const rulesReasoned = (entries, label) => {
  for (const entry of entries) {
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw new TypeError(`${label}: every exception states its reason`);
    }
  }
  return entries;
};
