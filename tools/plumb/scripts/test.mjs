import { mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2] ?? "core";
if (!["core", "javascript", "unit", "native", "python"].includes(mode)) throw new Error("Test suite is core, javascript, unit, native, or python");
const folder = join(root, mode === "core" ? "test" : mode === "native" ? "test/integration" : mode === "python" ? "packages/python/test" : "packages/javascript/test");
const files = readdirSync(folder).filter((file) => file.endsWith(".test.mjs") && (mode !== "unit" || file === "lint-unit.test.mjs")).map((file) => join(folder, file));
const temporary = process.env.PLUMB_TEST_TMP ?? resolve(root, "../.plumb-tests");
mkdirSync(temporary, { recursive: true });
const result = spawnSync(process.execPath, ["--import", join(root, "test/resolve-core.mjs"), "--test", ...files], { cwd: root, env: { ...process.env, PLUMB_TEST_TMP: temporary }, stdio: "inherit" });
process.exitCode = result.error ? 2 : result.status ?? 2;
