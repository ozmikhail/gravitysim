import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkerIdentity } from "../src/engine.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export const BUN_VERSION = "1.4.4";
export const TARGETS = Object.freeze(["bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64", "bun-windows-x64"]);
const platform = process.platform === "win32" ? "windows" : process.platform;
const defaultTarget = `bun-${platform}-${process.arch}`;

// This stage can be exercised with Node even when the optional compiler is unavailable.
export function prepareBuild(staging) {
  mkdirSync(staging, { recursive: true });
  if (readdirSync(staging).length) throw new Error("Build staging must be empty");
  const identity = checkerIdentity().sha256;
  const embedded = Object.fromEntries(readdirSync(join(root, "src/assets")).sort().map((file) => [file, readFileSync(join(root, "src/assets", file), "utf8")]));
  const loader = 'readFileSync(new URL(`./assets/${name}`, import.meta.url), "utf8")';
  const source = readFileSync(join(root, "src/assets.mjs"), "utf8");
  if (source.split(loader).length !== 2) throw new Error("Standalone asset loader changed; update embedding before building");
  const assets = `const embeddedAssets = ${JSON.stringify(embedded)};\nfunction embeddedAsset(name) {\n  if (!Object.hasOwn(embeddedAssets, name)) throw new Error(\`Missing embedded asset \${name}\`);\n  return embeddedAssets[name];\n}\n${source.replace(loader, "embeddedAsset(name)")}`;
  mkdirSync(join(staging, "src"));
  for (const file of readdirSync(join(root, "src")).filter((file) => file.endsWith(".mjs"))) cpSync(join(root, "src", file), join(staging, "src", file));
  writeFileSync(join(staging, "src/assets.mjs"), assets);
  const entry = join(staging, "entry.mjs");
  writeFileSync(entry, `globalThis.__PLUMB_BUILD_ID__ = ${JSON.stringify(identity)};\nconst { main } = await import("./src/cli.mjs");\nprocess.exitCode = await main(process.argv.slice(2));\n`);
  writeFileSync(join(staging, "package.json"), '{"type":"module"}\n');
  return { entry, identity };
}

export function build(target = defaultTarget, { run = spawnSync, outputDirectory = join(root, "dist") } = {}) {
  if (!TARGETS.includes(target)) throw new Error(`Target must be one of ${TARGETS.join(", ")}`);
  const bun = run("bun", ["--version"], { encoding: "utf8" });
  if (bun.error || bun.status !== 0 || bun.stdout?.trim() !== BUN_VERSION) throw new Error(`Standalone builds require Bun ${BUN_VERSION}. The regular Node CLI needs no build.`);
  const directory = resolve(outputDirectory);
  const extension = target.includes("windows") ? ".exe" : "";
  const output = join(directory, `plumb-${target.slice(4)}${extension}`);
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(join(directory, ".plumb-build-"));
  try {
    prepareBuild(staging);
    const compiled = join(staging, `plumb-compiled${extension}`);
    const result = run("bun", ["build", "--compile", `--target=${target}`, "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "entry.mjs", "--outfile", compiled], { cwd: staging, stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error(`Bun compilation failed: ${result.error?.message ?? `exit ${result.status ?? "unknown"}`}`);
    const artifact = statSync(compiled);
    if (!artifact.isFile() || artifact.size === 0) throw new Error("Bun did not produce a standalone executable");
    renameSync(compiled, output);
    return output;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length > 3) throw new Error("Usage: node scripts/build.mjs [target]");
    process.stdout.write(`${build(process.argv[2])}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
