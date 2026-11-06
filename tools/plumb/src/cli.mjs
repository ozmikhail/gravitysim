import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkRepository, checkerIdentity, context, coreRules, doctor, inspect, javascriptPack, planRepository, report, scaffoldRepository, testPolicy } from "./engine.mjs";
import { digest, safePath } from "./files.mjs";
import { syncAssets } from "./assets.mjs";
import { nativeSteps } from "./native.mjs";
import { executeSteps } from "./process.mjs";
import { loadConfig, schema, validateSchema } from "./config.mjs";
import { diffPolicies } from "./bundles.mjs";
import { toSarif } from "./diagnostics.mjs";
import { applyRepairs, previewRepairs } from "./repair.mjs";
import { inputDigest, loadInputs } from "./workspace.mjs";

const USAGE = `Plumb — executable repository contracts

Usage: plumb <command> [options]

  init                  create a small plumb.json; never overwrite existing files
  check                 run the complete, read-only policy
  plan                  show required checks, ownership and task obligations
  doctor                check prerequisites and suggest adoption steps
  inspect               show effective policy, coverage and rule metadata
  explain RULE          show one rule's purpose and remedy
  fix                   apply conservative source formatting, then check
  sync                  write or repair Plumb-owned files and executable modes
  snapshot              explicitly update configured public API snapshots
  prepare               explicitly run configured code-generation commands
  policy-diff           compare effective policy with --against FILE
  pin-policy FILE       print an offline bundle reference with its content hash
  pin-input PATH        print the digest for an approved input file or directory
  policy-test           run approved convention examples and intentional violations
  scaffold ROLE NAME    validate and create policy-defined source and companion files

  --root PATH           project root (otherwise discover plumb.json upwards)
  --config FILE         repository-relative JSON policy (default plumb.json)
  --policy FILE         use an approved policy outside the candidate checkout
  --task FILE           add an approved external task contract
  --adapters FILE       use an approved external pinned adapter registry
  --inputs FILE         add explicitly pinned inputs to an isolated check
  --file PATH           explain one file's owner, checks and exclusions (inspect)
  --dry-run             preview conservative repairs or scaffolding
  --apply FILE          apply a reviewed repair plan after hash/mode validation
  --output FILE         save JSON, SARIF or a repair plan outside the project
  --cache DIRECTORY     reuse unchanged deterministic core results outside CI
  --format FORMAT       text, json, or sarif (check only)
  --profile PROFILE     init a typescript, react, ruby, cpp or generic project
  --preset PRESET       init with ozlabs (default) or portable
  --project PATH        snapshot only this configured project

Exit codes: 0 complete success; 1 policy violation; 2 incomplete or invalid invocation.
`;
const valueFlags = new Set(["--root", "--config", "--policy", "--format", "--profile", "--preset", "--project", "--task", "--adapters", "--inputs", "--file", "--apply", "--output", "--against", "--cache"]);
const booleanFlags = new Set(["--dry-run"]);
function argumentsOf(args) {
  const options = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${arg} needs a value`);
      if (Object.hasOwn(options, arg.slice(2))) throw new Error(`${arg} was supplied twice`);
      options[arg.slice(2)] = args[++i];
    } else if (booleanFlags.has(arg)) {
      if (Object.hasOwn(options, arg.slice(2))) throw new Error(`${arg} was supplied twice`);
      options[arg.slice(2)] = true;
    } else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  const [command, ...rest] = positional;
  if (options.format && !["text", "json", "sarif"].includes(options.format)) throw new Error("--format is text, json, or sarif");
  if (options.format === "sarif" && command !== "check") throw new Error("SARIF output is only supported by check");
  if ((options.profile || options.preset) && command !== "init") throw new Error("--profile and --preset are only supported by init");
  if (options.project && command !== "snapshot") throw new Error("--project is only supported by snapshot");
  if (options.cache && command !== "check") throw new Error("Result caching is only supported by check");
  if (options.task && !["check", "plan", "doctor"].includes(command)) throw new Error("--task is supported by check, plan and doctor");
  if (options.inputs && !["check", "fix", "policy-test", "scaffold"].includes(command)) throw new Error("--inputs is supported by check, fix, policy-test and scaffold");
  if (options.file && command !== "inspect") throw new Error("--file is only supported by inspect");
  if (options["dry-run"] && !["fix", "scaffold"].includes(command)) throw new Error("--dry-run is supported by fix and scaffold");
  if (options.apply && command !== "fix") throw new Error("--apply is only supported by fix");
  if (options["dry-run"] && options.apply) throw new Error("Choose repair preview or plan application");
  if (options.against && command !== "policy-diff" || command === "policy-diff" && !options.against) throw new Error("policy-diff requires --against FILE");
  if (options.output && !["check", "plan", "doctor", "inspect", "fix", "policy-test", "scaffold", "policy-diff", "pin-policy", "pin-input"].includes(command)) throw new Error("This command does not produce a saved report");
  if (rest.length !== (command === "scaffold" ? 2 : ["explain", "pin-policy", "pin-input"].includes(command) ? 1 : 0)) throw new Error(`${command} has invalid positional arguments`);
  return { command, rest, ...options, configFile: options.config, inputManifest: options.inputs, dryRun: options["dry-run"] };
}
function discover(start, file) {
  let root = resolve(start);
  for (;;) {
    if (existsSync(join(root, file))) return root;
    const parent = dirname(root);
    if (parent === root) return resolve(start);
    root = parent;
  }
}
const issue = (rule, path, message, remedy) => ({ rule, path, message, remedy, status: "incomplete", suppressible: false });

async function conservativeFix(options) {
  const ctx = context({ ...options, mode: "fix" }), diagnostics = [], written = [];
  if (ctx.config.projects.some((project) => ["typescript", "react"].includes(project.profile))) {
    const result = await (await javascriptPack()).fix(ctx);
    diagnostics.push(...result.diagnostics); written.push(...result.written);
  }
  const native = await executeSteps(ctx, nativeSteps(ctx, "fix"));
  diagnostics.push(...native.diagnostics);
  return { diagnostics, written };
}

function saveOutput(root, file, value) {
  const target = resolve(file), candidate = existsSync(root) ? realpathSync(root) : resolve(root);
  let parent = dirname(target); const missing = [];
  while (!existsSync(parent)) { missing.unshift(basename(parent)); parent = dirname(parent); }
  const actual = join(realpathSync(parent), ...missing, basename(target));
  const offset = relative(candidate, actual);
  if (offset !== ".." && !offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(offset)) throw new Error("Save reports and repair plans outside the candidate repository");
  mkdirSync(dirname(actual), { recursive: true });
  writeFileSync(actual, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  return actual;
}

function init(options) {
  const root = options.root;
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const path = safePath(root, options.configFile ?? "plumb.json", { allowMissing: true });
  if (existsSync(path)) throw new Error(`Refusing to overwrite ${path}`);
  const profile = options.profile ?? "generic", preset = options.preset ?? "ozlabs";
  if (!["generic", "typescript", "react", "ruby", "cpp"].includes(profile)) throw new Error(`Unknown profile ${profile}`);
  if (!["ozlabs", "portable"].includes(preset)) throw new Error(`Unknown preset ${preset}`);
  const config = { schemaVersion: 1, preset, projects: profile === "generic" ? [] : [{ root: ".", profile, ...(profile === "cpp" ? { compileCommands: "build" } : {}) }] };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  const written = [options.configFile ?? "plumb.json"];
  if (preset === "ozlabs" && !existsSync(join(root, "AGENTS.md"))) {
    writeFileSync(join(root, "AGENTS.md"), "# Agent instructions\n\nRun `plumb inspect` to read the effective policy and `plumb check --format json` for diagnostics.\nResolve violations in source. Changes to policy, exceptions or API snapshots require review.\nUse `plumb fix` for source formatting and `plumb sync` for owned assets.\n", { flag: "wx" });
    written.push("AGENTS.md");
  }
  return report([], { command: "init", written, next: "Run plumb sync, then plumb check. Language profiles need their documented toolchains." });
}

async function mutation(options) {
  const ctx = context({ ...options, mode: options.command });
  if (options.command === "sync") {
    const result = await syncAssets(ctx);
    return report(result.diagnostics, { command: "sync", written: result.written });
  }
  if (options.command === "snapshot") {
    const pack = await javascriptPack(), proposals = await pack.snapshot(ctx, options.project);
    if (!proposals.length) throw new Error("No public API snapshot is configured for this project");
    const prepared = proposals.map((item) => {
      if (!item.path.endsWith(".surface.json")) throw new Error("API snapshots must use a dedicated .surface.json filename");
      const target = ctx.safePath(item.path, { allowMissing: true });
      if (existsSync(target)) {
        const previous = JSON.parse(readFileSync(target, "utf8"));
        if (!pack.surfaceSnapshotIsValid(previous)) throw new Error(`Refusing to replace an unrelated file at ${item.path}`);
      }
      return { ...item, target };
    });
    for (const item of prepared) { mkdirSync(dirname(item.target), { recursive: true }); writeFileSync(item.target, item.content); }
    return report([], { command: "snapshot", written: prepared.map((item) => item.path), next: "Review the public API change before approving the new snapshot." });
  }
  if (options.command === "prepare") {
    const steps = ctx.config.projects.flatMap((project) => (project.prepare ?? []).map((command, index) => ({ id: `prepare.${project.root}.${index + 1}`, path: project.root, cwd: ctx.safePath(project.root), command })));
    const result = await executeSteps(ctx, steps);
    return report(result.diagnostics, { command: "prepare", checks: result.checks });
  }
  const inputs = options.inputManifest ? loadInputs(options.inputManifest, ctx.root) : undefined;
  const hasJavascript = ctx.config.projects.some((project) => ["typescript", "react"].includes(project.profile));
  const checker = checkerIdentity(hasJavascript ? (await javascriptPack()).identity : undefined);
  let plan;
  if (options.apply) { const saved = JSON.parse(readFileSync(resolve(options.apply), "utf8")); plan = saved.plan ?? saved; }
  else plan = await previewRepairs(ctx, (root) => conservativeFix({ ...options, root, originalRoot: ctx.root, registry: ctx.registry }), { checker, inputs });
  if (options.dryRun) return report([], { command: "fix", dryRun: true, plan, written: [], next: "Review the patch and apply the saved plan with plumb fix --apply FILE." });
  const { written } = applyRepairs(ctx, plan, { checker, inputs });
  const checked = await checkRepository(options);
  return report(checked.diagnostics, { ...checked, command: "fix", written });
}


export async function main(args, output = (text) => process.stdout.write(text)) {
  if (args.length === 0 || args.includes("--help") || args[0] === "help") { output(USAGE); return 0; }
  let options, result;
  try {
    options = argumentsOf(args);
    options.root = options.root ? resolve(options.root) : discover(process.cwd(), options.configFile ?? "plumb.json");
    switch (options.command) {
      case "init": result = init(options); break;
      case "check": result = await checkRepository(options); break;
      case "policy-test": result = await testPolicy(options); break;
      case "scaffold": result = await scaffoldRepository({ ...options, role: options.rest[0], name: options.rest[1] }); break;
      case "plan": result = planRepository(options); break;
      case "doctor": result = await doctor(options); break;
      case "inspect": result = await inspect(options); break;
      case "policy-diff": {
        const current = context(options), previous = loadConfig(current.root, options.configFile, resolve(options.against));
        result = { schemaVersion: 1, command: "policy-diff", changes: diffPolicies({ value: previous.config, origins: previous.origins }, { value: current.config, origins: current.origins }) }; break;
      }
      case "pin-policy": {
        const path = resolve(options.rest[0]), bytes = readFileSync(path);
        validateSchema(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), schema);
        result = { path, sha256: digest(bytes) }; break;
      }
      case "pin-input": {
        const source = resolve(options.rest[0]); result = { source, sha256: inputDigest(source) }; break;
      }
      case "explain": {
        let rules = coreRules();
        if (!rules.some((rule) => rule.id === options.rest[0])) rules = (await inspect(options)).rules;
        const rule = rules.find((entry) => entry.id === options.rest[0]);
        if (!rule) throw new Error(`Unknown rule ${options.rest[0]}; run plumb inspect`);
        result = { schemaVersion: 1, rule }; break;
      }
      case "fix": case "sync": case "snapshot": case "prepare": result = await mutation(options); break;
      default: throw new Error(`Unknown command ${options.command}; run plumb --help`);
    }
    if (options.output) result.saved = saveOutput(options.root, options.output, options.dryRun && result.plan ? result.plan : options.format === "sarif" ? toSarif(result) : result);
  } catch (error) { result = report([issue("run.failed", ".", error.message, "Correct the invocation or configuration and retry.")]); }
  if (options?.format === "sarif" || args.includes("sarif") && args.includes("--format")) output(`${JSON.stringify(toSarif(result), null, 2)}\n`);
  else if (options?.format === "json" || args.includes("json") && args.includes("--format") || ["inspect", "explain", "plan", "doctor", "policy-diff", "pin-policy", "pin-input"].includes(options?.command)) output(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const diagnostic of result.diagnostics ?? []) output(`${diagnostic.path}${diagnostic.line ? `:${diagnostic.line}` : ""} [${diagnostic.rule}] ${diagnostic.message}\n  ${diagnostic.remedy}\n`);
    for (const path of result.written ?? []) output(`Wrote ${path}\n`);
    if (result.plan?.patch) output(result.plan.patch);
    if (result.saved) output(`Saved ${result.saved}\n`);
    output(`Plumb: ${result.status ?? "complete"}${result.suppressed?.length ? ` (${result.suppressed.length} declared exceptions)` : ""}\n`);
    if (result.next) output(`${result.next}\n`);
  }
  return result.exitCode ?? 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
