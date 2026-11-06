import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../bin/plumb.mjs", import.meta.url));
const node = isAbsolute(process.execPath) ? process.execPath : (process.env.PATH ?? "").split(delimiter).map((folder) => join(folder, process.execPath)).find(existsSync) ?? process.execPath;
const temporary = process.env.PLUMB_TEST_TMP ?? fileURLToPath(new URL("../../../.plumb-tests/", import.meta.url));
const rubyPass = '# frozen_string_literal: true\n\nputs "hello"\n';
const cppPass = "int main() { return 0; }\n";

function execute(command, options = {}) {
  return spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
}
function requireTools(commands) {
  const probes = commands.map((command) => ({ command, result: execute(command) }));
  const failures = probes.filter(({ result }) => result.error || result.status !== 0);
  assert.equal(failures.length, 0, `Native integration prerequisites unavailable:\n${failures.map(({ command, result }) => `${command.join(" ")}: ${result.error?.message ?? result.stderr ?? result.stdout}`).join("\n")}\nInstall Ruby, RuboCop with rubocop-performance and rubocop-rspec, clang-format, clang-tidy, and a C++ compiler. This suite never skips missing tools.`);
  return probes.map(({ result }) => `${result.stdout}\n${result.stderr}`.trim());
}
function compiler() {
  const commands = process.env.CXX ? [process.env.CXX] : ["clang++", "g++", "c++"];
  const found = commands.find((command) => { const result = execute([command, "--version"]); return !result.error && result.status === 0; });
  assert.ok(found, "Native integration prerequisites unavailable: install a C++ compiler or set CXX to its executable path. This suite never skips missing tools.");
  return found;
}
function fixture(t, projects, contents) {
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, "native-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  // The preset selects unrelated repository contracts; native profiles retain their full strict assets.
  write("plumb.json", `${JSON.stringify({ schemaVersion: 1, preset: "portable", projects })}\n`);
  for (const [path, text] of Object.entries(contents)) write(path, text);
  return { root, write };
}
function contents(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? contents(root, path) : [[path, readFileSync(join(root, path)).toString("base64")]];
  });
}
function invoke(root, command, expectedCode, env = process.env) {
  const before = command === "check" ? contents(root) : undefined;
  const result = execute([node, cli, command, "--root", root, "--format", "json"], { cwd: root, env });
  assert.ifError(result.error);
  assert.equal(result.status, expectedCode, `plumb ${command}\n${result.stdout}\n${result.stderr}`);
  const body = JSON.parse(result.stdout);
  assert.equal(body.status, ["pass", "violation", "incomplete"][expectedCode], JSON.stringify(body, null, 2));
  if (before) assert.deepEqual(contents(root), before, "check must preserve the source, policy, and native assets");
  return body;
}
function covered(body, id, status, files) {
  const row = body.coverage.find((item) => item.id === id);
  assert.ok(row, `Missing native coverage record ${id}: ${JSON.stringify(body, null, 2)}`);
  assert.equal(row.status, status, JSON.stringify(body, null, 2));
  assert.equal(row.completed, status !== "incomplete");
  assert.deepEqual(row.checkedFiles, files);
}
function cppFixture(t, executable) {
  const project = fixture(t, [{ root: ".", profile: "cpp", compileCommands: "build" }], { "main.cpp": cppPass });
  project.write("build/compile_commands.json", JSON.stringify([{ directory: project.root, file: "main.cpp", arguments: [executable, "-std=c++20", "-c", "main.cpp", "-o", "build/main.o"] }]));
  // clang-tidy consumes a real compile command; syntax checking needs no object-file build.
  const parsed = execute([executable, "-std=c++20", "-fsyntax-only", "main.cpp"], { cwd: project.root });
  assert.ifError(parsed.error);
  assert.equal(parsed.status, 0, parsed.stderr);
  invoke(project.root, "sync", 0);
  assert.match(readFileSync(join(project.root, ".clang-tidy"), "utf8"), /WarningsAsErrors: "\*"/);
  assert.match(readFileSync(join(project.root, ".clang-format"), "utf8"), /"InsertBraces": true/);
  assert.doesNotMatch(readFileSync(join(project.root, ".clang-format-ignore"), "utf8"), /^[^#\s]/m);
  return project;
}

test("real Ruby/RuboCop accepts strict source and reports a source-level violation", (t) => {
  const versions = requireTools([["ruby", "--version"], ["ruby", "-S", "rubocop", "--version"], ["ruby", "-e", 'require "rubocop"; require "rubocop-performance"; require "rubocop-rspec"; puts "RuboCop plugins loaded"']]);
  versions.forEach((version) => t.diagnostic(version));
  const { root, write } = fixture(t, [{ root: ".", profile: "ruby" }], { "app.rb": rubyPass });
  invoke(root, "sync", 0);
  assert.match(readFileSync(join(root, ".rubocop.yml"), "utf8"), /EnabledByDefault: true/);
  const passed = invoke(root, "check", 0);
  covered(passed, "ruby.lint:.", "pass", ["app.rb"]);
  assert.ok(passed.identity.tools.rubocop);
  write("app.rb", "# frozen_string_literal: true\n\nputs 'hello'\n");
  const refused = invoke(root, "check", 1);
  covered(refused, "ruby.lint:.", "violation", ["app.rb"]);
  assert.ok(refused.diagnostics.some((item) => item.rule === "ruby.lint" && item.path === "app.rb" && /Style\/StringLiterals/.test(item.message) && item.line === 3));
});

test("real clang-format accepts strict formatting and refuses a formatting change", (t) => {
  requireTools([["clang-format", "--version"], ["clang-tidy", "--version"]]).forEach((version) => t.diagnostic(version));
  const { root, write } = cppFixture(t, compiler());
  const passed = invoke(root, "check", 0);
  covered(passed, "cpp.format:.", "pass", ["main.cpp"]);
  covered(passed, "cpp.lint:.", "pass", ["main.cpp"]);
  assert.ok(passed.identity.tools["clang-format"]);
  assert.ok(passed.identity.tools["clang-tidy"]);
  write("main.cpp", "int main(){return 0;}\n");
  const refused = invoke(root, "check", 1);
  covered(refused, "cpp.format:.", "violation", ["main.cpp"]);
  covered(refused, "cpp.lint:.", "pass", ["main.cpp"]);
  assert.ok(refused.diagnostics.some((item) => item.rule === "cpp.format"));
});

test("real clang-tidy accepts a compile database and refuses strict identifier naming", (t) => {
  requireTools([["clang-format", "--version"], ["clang-tidy", "--version"]]);
  const { root, write } = cppFixture(t, compiler());
  const passed = invoke(root, "check", 0);
  covered(passed, "cpp.lint:.", "pass", ["main.cpp"]);
  write("main.cpp", "int main() {\n  int BadName = 0;\n  return BadName;\n}\n");
  const refused = invoke(root, "check", 1);
  covered(refused, "cpp.format:.", "pass", ["main.cpp"]);
  covered(refused, "cpp.lint:.", "violation", ["main.cpp"]);
  assert.ok(refused.diagnostics.some((item) => item.rule === "cpp.lint" && /readability-identifier-naming/.test(item.message)));
});

test("the real CLI reports missing native executables as incomplete with no completed coverage", (t) => {
  const { root, write } = fixture(t, [{ root: "ruby", profile: "ruby" }, { root: "cpp", profile: "cpp", compileCommands: "cpp/build" }], { "ruby/app.rb": rubyPass, "cpp/main.cpp": cppPass });
  write("cpp/build/compile_commands.json", JSON.stringify([{ directory: join(root, "cpp"), file: "main.cpp", arguments: ["clang++", "-std=c++20", "-c", "main.cpp"] }]));
  invoke(root, "sync", 0);
  const emptyPath = join(root, "empty-path");
  mkdirSync(emptyPath);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  env.PATH = emptyPath;
  const result = invoke(root, "check", 2, env);
  for (const id of ["ruby.lint:ruby", "cpp.format:cpp", "cpp.lint:cpp"]) {
    covered(result, id, "incomplete", []);
    assert.ok(result.diagnostics.some((item) => item.check === id && item.status === "incomplete" && /Cannot locate executable/.test(item.message)));
  }
});
