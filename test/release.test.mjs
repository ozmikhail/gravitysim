import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { syncAssets } from "../src/assets.mjs";
import { definePlumb } from "../src/config.mjs";
import { checkRepository } from "../src/engine.mjs";

async function fixture(verify) {
  const root = mkdtempSync(join(process.env.PLUMB_TEST_TMP ?? tmpdir(), "plumb-release-test-"));
  const config = definePlumb({ schemaVersion: 1, preset: "portable", projects: [{ root: ".", profile: "cpp", compileCommands: "build" }] });
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  const database = JSON.stringify([{ directory: root, file: "src/main.cpp", arguments: ["c++", "-c", "src/main.cpp"] }]);
  try {
    write("plumb.json", JSON.stringify(config));
    write("src/main.cpp", "int main() { return 0; }\n");
    write("build/compile_commands.json", database);
    assert.deepEqual(syncAssets({ root, config }).diagnostics, []);
    await verify(root, write, database);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// These tests inject native process results to exercise core integrity, not Clang behavior.
const successful = (action = () => {}) => async (command) => {
  if (command.at(-1) === "--version") return { code: 0, stdout: "18.1.8", stderr: "" };
  await action(command);
  return { code: 0, stdout: "", stderr: "" };
};

test("ignored compilation metadata contributes to identity and cannot mutate during a check", async () => {
  await fixture(async (root, write, database) => {
    const first = await checkRepository({ root, execute: successful() });
    assert.equal(first.status, "pass", JSON.stringify(first.diagnostics));
    write("build/compile_commands.json", `${database}\n`);
    const second = await checkRepository({ root, execute: successful() });
    assert.equal(second.status, "pass", JSON.stringify(second.diagnostics));
    assert.notEqual(first.identity.snapshot, second.identity.snapshot);
    const changed = await checkRepository({ root, execute: successful(() => write("build/compile_commands.json", database)) });
    assert.equal(changed.status, "incomplete");
    assert.ok(changed.diagnostics.some(({ rule }) => rule === "run.mutated"));
  });
});

test("existing ignored formatting controls cannot mutate during native execution", async () => {
  await fixture(async (root, write) => {
    write("src/.clang-format-ignore", "# no exclusions\n");
    const changed = await checkRepository({ root, execute: successful(() => write("src/.clang-format-ignore", "*\n")) });
    assert.equal(changed.status, "incomplete");
    assert.ok(changed.diagnostics.some(({ rule }) => rule === "run.mutated"));
  });
});

test("a newly created ignored formatting control cannot turn an incomplete check into a pass", async () => {
  await fixture(async (root, write) => {
    const changed = await checkRepository({ root, execute: successful(() => write("src/.clang-format-ignore", "*\n")) });
    assert.equal(changed.status, "incomplete");
    assert.ok(changed.diagnostics.some(({ rule }) => ["run.mutated", "run.failed"].includes(rule)));
  });
});
