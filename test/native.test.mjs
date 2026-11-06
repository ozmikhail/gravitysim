import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { CLANG_FORMAT } from "../src/assets.mjs";
import { nativeSource, nativeSteps } from "../src/native.mjs";

function fixture(contents, verify) {
  const root = mkdtempSync(join(process.cwd(), ".plumb-native-test-"));
  try {
    writeFileSync(join(root, ".clang-format-ignore"), "# formatting scope comes from Plumb\n");
    for (const [path, content] of Object.entries(contents)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    verify(root, Object.keys(contents));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("C++ root '.' checks both formatting and translation units", () => {
  fixture({ "src/main.cpp": "int main() {}\n", "src/main.hpp": "", "build/compile_commands.json": "[]" }, (root, files) => {
    writeFileSync(join(root, "build/compile_commands.json"), JSON.stringify([{ directory: root, file: "src/main.cpp", arguments: ["c++", "-c", "src/main.cpp"] }]));
    const config = { projects: [{ root: ".", profile: "cpp", compileCommands: "build" }] };
    const steps = nativeSteps({ root, files, config });
    assert.deepEqual(steps.map(({ rule }) => rule), ["cpp.format", "cpp.lint"]);
    assert.deepEqual(steps.map(({ tool }) => tool), ["clang-format", "clang-tidy"]);
    assert.ok(steps[0].command.includes("./src/main.cpp"));
    assert.ok(steps[0].command.includes("./src/main.hpp"));
    assert.ok(steps[0].command.includes("--dry-run"));
    assert.ok(!steps[1].command.includes("./src/main.hpp"));
    assert.ok(steps[1].command.includes(join(root, ".clang-tidy")));
    assert.equal(nativeSteps({ root, files, config }, "fix").length, 1);
  });
});

test("native scopes cannot silently pass when empty, header-only, or unprepared", () => {
  fixture({ "readme.txt": "", "include/a.hpp": "", "src/a.cpp": "" }, (root, files) => {
    assert.throws(() => nativeSteps({ root, files, config: { projects: [{ root: ".", profile: "ruby" }] } }), /no ruby source/);
    assert.throws(() => nativeSteps({ root, files: ["include/a.hpp"], config: { projects: [{ root: ".", profile: "cpp", compileCommands: "build" }] } }), /translation unit/);
    assert.throws(() => nativeSteps({ root, files, config: { projects: [{ root: ".", profile: "cpp", compileCommands: "build" }] } }), /compilation database/);
  });
});

test("C++ fix preserves include order and control flow while check retains strict policy", () => {
  fixture({ "src/main.cpp": '#include "z-init.hpp"\n#include "a-consumer.hpp"\nvoid run() { if (ready) consume(); }\n', "build/compile_commands.json": "[]" }, (root, files) => {
    writeFileSync(join(root, "build/compile_commands.json"), JSON.stringify([{ directory: root, file: "src/main.cpp", arguments: ["c++", "-c", "src/main.cpp"] }]));
    const context = { root, files, config: { projects: [{ root: ".", profile: "cpp", compileCommands: "build" }] } };
    const [fix] = nativeSteps(context, "fix");
    const style = JSON.parse(fix.command.find((argument) => argument.startsWith("--style=")).slice("--style=".length));
    assert.equal(style.SortIncludes, "Never");
    assert.equal(style.IncludeBlocks, "Preserve");
    assert.equal(style.InsertBraces, false);
    assert.equal(style.ColumnLimit, CLANG_FORMAT.ColumnLimit);
    assert.equal(style.PointerAlignment, CLANG_FORMAT.PointerAlignment);
    assert.ok(fix.command.includes("-i"));
    const [check] = nativeSteps(context, "check");
    assert.ok(check.command.includes(`--style=file:${join(root, ".clang-format")}`));
    assert.ok(check.command.includes("--dry-run"));
    assert.equal(CLANG_FORMAT.SortIncludes, "CaseSensitive");
    assert.equal(CLANG_FORMAT.InsertBraces, true);
  });
});

test("every C++ translation unit requires a valid compilation database entry", () => {
  fixture({ "src/a.cpp": "", "build/compile_commands.json": "[]" }, (root, files) => {
    const context = { root, files, config: { projects: [{ root: ".", profile: "cpp", compileCommands: "build" }] } };
    assert.throws(() => nativeSteps(context), /no compiler command/);
    writeFileSync(join(root, "build/compile_commands.json"), JSON.stringify([{ directory: root, file: "src/a.cpp" }]));
    assert.throws(() => nativeSteps(context), /compiler command objects/);
    writeFileSync(join(root, "build/compile_commands.json"), JSON.stringify([{ directory: root, file: "src/a.cpp", command: "c++ -c src/a.cpp" }]));
    assert.equal(nativeSteps(context).length, 2);
  });
});

test("Ruby runs in its project root with explicit policy and disabled cache", () => {
  fixture({ "ruby/Gemfile": "", "ruby/lib/user.rb": "", "other/file.rb": "" }, (root, files) => {
    const [step] = nativeSteps({ root, files, config: { projects: [{ root: "ruby", profile: "ruby" }] } });
    assert.equal(step.cwd, join(root, "ruby"));
    assert.equal(step.tool, "rubocop");
    assert.deepEqual(step.command.slice(0, process.platform === "win32" ? 5 : 3), [...(process.platform === "win32" ? ["ruby", "-S"] : []), "bundle", "exec", "rubocop"]);
    assert.ok(step.command.includes(join(root, "ruby/.rubocop.yml")));
    assert.deepEqual(step.command.slice(step.command.indexOf("--cache"), step.command.indexOf("--cache") + 2), ["--cache", "false"]);
    assert.ok(step.command.includes("./lib/user.rb"));
    assert.ok(!step.command.includes("./other/file.rb"));
    assert.ok(!step.command.includes("--autocorrect"));
  });
});

test("unbundled Ruby uses its native executable without shell interpolation", () => {
  fixture({ "odd folder/main.rb": "" }, (root, files) => {
    const [step] = nativeSteps({ root, files, config: { projects: [{ root: "odd folder", profile: "ruby" }] } }, "fix");
    assert.equal(step.command[process.platform === "win32" ? 2 : 0], "rubocop");
    assert.ok(step.command.includes("--autocorrect"));
    assert.ok(step.command.includes(join(root, "odd folder/.rubocop.yml")));
  });
});

test("nested native projects own their source exactly once, including one-letter roots", () => {
  fixture({ "main.rb": "", "a/lib.rb": "", "a/deep/inner.rb": "" }, (root, files) => {
    const config = { projects: [{ root: ".", profile: "ruby" }, { root: "./a/", profile: "ruby" }, { root: "a/deep", profile: "ruby" }] };
    const steps = nativeSteps({ root, files, config });
    assert.deepEqual(steps.map(({ path }) => path), [".", "a", "a/deep"]);
    assert.deepEqual(steps.map(({ command }) => command.slice(command.indexOf("--") + 1)), [["./main.rb"], ["./lib.rb"], ["./inner.rb"]]);
  });
});

test("shared native scopes include Ruby entry files and reject unsupported profiles", () => {
  for (const path of ["Gemfile", "Rakefile", "ruby/Gemfile", "lib/tool.rb", "lib/build.rake", "gem/tool.gemspec"]) assert.equal(nativeSource("ruby", path), true, path);
  assert.equal(nativeSource("ruby", "Gemfile.lock"), false);
  assert.equal(nativeSource("ruby", "notGemfile"), false);
  assert.equal(nativeSource("cpp", "src/main.cpp"), true);
  assert.equal(nativeSource("cpp", "include/core.hxx"), true);
  assert.equal(nativeSource("typescript", "src/main.cpp"), false);
});

test("C++ formatting refuses hidden ignores and requires its owned boundary", () => {
  fixture({ "src/a.cpp": "", "src/.clang-format-ignore": "*\n" }, (root) => {
    const context = { root, files: ["src/a.cpp"], config: { projects: [{ root: ".", profile: "cpp", compileCommands: "build" }] } };
    for (const mode of ["check", "fix"]) assert.throws(() => nativeSteps(context, mode), /ignore patterns.*plumb\.json/);
    writeFileSync(join(root, "src/.clang-format-ignore"), "  # no patterns\n\n");
    const read = [];
    assert.equal(nativeSteps({ ...context, read: (path) => { read.push(path); return "# no patterns\n"; } }, "fix").length, 1);
    assert.deepEqual(read.sort(), [".clang-format-ignore", "src/.clang-format-ignore"]);
    rmSync(join(root, ".clang-format-ignore"));
    assert.throws(() => nativeSteps(context, "fix"), /run plumb sync.*inherited ignore/);
  });
});

test("a nested C++ project stops ignore discovery at its owned project boundary", () => {
  fixture({ ".clang-format-ignore": "*\n", "native/.clang-format-ignore": "# isolated\n", "native/src/a.cpp": "" }, (root, files) => {
    const context = { root, files, config: { projects: [{ root: "native", profile: "cpp", compileCommands: "native/build" }] } };
    assert.equal(nativeSteps(context, "fix").length, 1);
  });
});
