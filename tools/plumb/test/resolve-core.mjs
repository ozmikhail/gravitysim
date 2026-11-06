import { registerHooks } from "node:module";

// Resolve the development peer without installing the optional language toolchain.
const modules = new Set(["files", "comments", "process", "config", "adapters", "conventions"]);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@ozlabs/plumb") return { url: new URL("../src/engine.mjs", import.meta.url).href, shortCircuit: true };
  const name = specifier.replace(/^@ozlabs\/plumb\//, "");
  if (specifier.startsWith("@ozlabs/plumb/") && modules.has(name)) return { url: new URL(`../src/${name}.mjs`, import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
