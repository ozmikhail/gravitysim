import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Run the same CLI contract against an unpacked Node entry or an isolated binary.
export function smoke(command, { temporaryRoot = process.env.PLUMB_TEST_TMP ?? tmpdir(), copyExecutable = false, expectedIdentity } = {}) {
  mkdirSync(temporaryRoot, { recursive: true });
  const temporary = mkdtempSync(join(temporaryRoot, "plumb-smoke-"));
  try {
    if (copyExecutable) {
      const executable = join(temporary, basename(command[0]));
      copyFileSync(command[0], executable);
      chmodSync(executable, 0o755);
      command = [executable, ...command.slice(1)];
    }
    const root = join(temporary, "project");
    mkdirSync(root);
    const dotenvKey = `PLUMB_SMOKE_${randomUUID().replaceAll("-", "_")}`;
    writeFileSync(join(temporary, ".env"), `${dotenvKey}=unexpected\n`);
    writeFileSync(join(temporary, "bunfig.toml"), 'preload = ["./preload.mjs"]\n');
    writeFileSync(join(temporary, "preload.mjs"), 'process.stderr.write("Unexpected bunfig preload\\n"); process.exit(83);\n');
    const invoke = (args, code) => {
      const result = spawnSync(command[0], [...command.slice(1), ...args], { cwd: temporary, encoding: "utf8" });
      assert.ifError(result.error);
      assert.equal(result.status, code, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const run = (args, code = 0) => JSON.parse(invoke([...args, "--root", root, "--format", "json"], code));
    const policyPath = join(root, "plumb.json");
    const setPolicy = (value) => writeFileSync(policyPath, `${JSON.stringify({ schemaVersion: 1, preset: "portable", projects: [], ...value })}\n`);
    assert.equal(run(["init", "--preset", "portable"]).status, "pass");
    assert.equal(existsSync(join(root, "package.json")), false);
    const checked = run(["check"]);
    assert.equal(checked.status, "pass");
    assert.match(checked.identity.checker.sha256, /^[a-f0-9]{64}$/);
    if (expectedIdentity) assert.equal(checked.identity.checker.sha256, expectedIdentity);
    setPolicy({ projects: [{ root: ".", profile: "ruby", prepare: [[process.execPath, "-e", "process.exit(Object.hasOwn(process.env, process.argv[1]) ? 83 : 0)", dotenvKey]] }] });
    assert.equal(run(["prepare"]).status, "pass");
    setPolicy({ files: { required: ["required.txt"] } });
    assert.equal(run(["check"], 1).status, "violation");
    writeFileSync(join(root, "required.txt"), "present\n");
    assert.equal(run(["check"]).status, "pass");
    setPolicy({ unknownOption: true });
    assert.equal(run(["check"], 2).status, "incomplete");
    for (const name of ["ruby", "cpp"]) mkdirSync(join(root, name));
    setPolicy({ projects: [{ root: "ruby", profile: "ruby" }, { root: "cpp", profile: "cpp", compileCommands: "cpp/build" }] });
    assert.equal(run(["sync"]).status, "pass");
    assert.match(readFileSync(join(root, "ruby/.rubocop.yml"), "utf8"), /EnabledByDefault: true/);
    assert.match(readFileSync(join(root, "cpp/.clang-tidy"), "utf8"), /WarningsAsErrors: "\*"/);
    const style = JSON.parse(readFileSync(join(root, "cpp/.clang-format"), "utf8").split("\n").slice(1).join("\n"));
    assert.equal(style.InsertBraces, true);
    assert.deepEqual(run(["sync"]).written, []);
    setPolicy({ projects: [{ root: ".", profile: "typescript" }] });
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
    assert.equal(run(["sync"]).status, "pass");
    const missingPack = run(["check"], 2);
    assert.equal(missingPack.status, "incomplete");
    assert.ok(missingPack.diagnostics.some((item) => /@ozlabs\/plumb-javascript/.test(item.message)));
    return { status: "pass", checker: checked.identity.checker };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/smoke.mjs PATH_TO_STANDALONE_BINARY");
    process.stdout.write(`${JSON.stringify(smoke([resolve(process.argv[2])], { copyExecutable: true }))}\n`);
  } catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 2; }
}
