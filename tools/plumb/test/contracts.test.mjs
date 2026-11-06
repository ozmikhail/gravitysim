import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkFiles } from "../src/contracts.mjs";

function fixture(contents, verify) {
  const root = mkdtempSync(join(process.cwd(), ".plumb-contract-test-"));
  try {
    for (const [path, content] of Object.entries(contents)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    verify((config) => checkFiles({ root, files: Object.keys(contents), config, read: (path) => readFileSync(join(root, path), "utf8") }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("portable file contracts pass on any language without a package manifest", () => {
  fixture({ "src/main.py": "print(1)\n", "LICENSE": "license\n", "logo.png": "\0\n\n\n" }, (check) => {
    assert.deepEqual(check({ preset: "portable", files: { required: ["LICENSE"], forbidden: ["**/*.secret"], names: [{ files: ["src/*.py"], pattern: "^[a-z]+\\.py$", reason: "consistent Python filenames" }], maxLines: 1 } }), []);
  });
});

test("required, forbidden, naming, and line budget failures are distinct", () => {
  fixture({ "src/Bad.py": "one\ntwo\n", "token.secret": "secret" }, (check) => {
    const problems = check({ preset: "portable", files: { required: ["LICENSE"], forbidden: ["**/*.secret"], names: [{ files: ["src/*.py"], pattern: "^[a-z]+\\.py$", reason: "consistent filenames" }], maxLines: 1 } });
    assert.deepEqual(problems.map(({ rule }) => rule).sort(), ["files.forbidden", "files.max-lines", "files.names", "files.required"]);
    assert.ok(problems.every(({ remedy }) => typeof remedy === "string" && remedy.length));
  });
});

test("declared naming scopes cannot silently match nothing", () => {
  fixture({ "src/a.py": "pass\n" }, (check) => {
    const [problem] = check({ preset: "portable", files: { names: [{ files: ["typo/*.py"], pattern: ".*", reason: "name Python files" }] } });
    assert.equal(problem.rule, "files.scope");
    assert.equal(problem.status, "incomplete");
    assert.equal(problem.suppressible, false);
  });
});

test("OzLabs preserves language-specific file and folder conventions", () => {
  fixture({ "AGENTS.md": "# Agents\n", "src/session.integration.test.ts": "", "lib/user_store.rb": "", "src/net/tcp_socket.cpp": "", ".github/scripts/release-notes.ts": "", "ui/button.module.css": "" }, (check) => assert.deepEqual(check({ preset: "ozlabs" }), []));
  fixture({ "AGENTS.md": "# Agents\n", "src/BadFile.tsx": "", "lib/user-store.rb": "", "net-io/socket.cpp": "" }, (check) => {
    assert.equal(check({ preset: "ozlabs" }).filter(({ rule }) => rule === "files.names").length, 3);
  });
});

test("a root README index includes every nested guide", () => {
  const contents = { "README.md": "# Index\n\n[agents](AGENTS.md)\n", "AGENTS.md": "# Agents\n", "docs/guide.md": "# Guide\n" };
  fixture(contents, (check) => assert.deepEqual(check({ preset: "ozlabs", docs: { index: "README.md" } }).map(({ rule, message }) => [rule, message]), [["docs.index", "Missing guide docs/guide.md."]]));
  fixture({ ...contents, "README.md": contents["README.md"] + "[guide](docs/guide.md)\n" }, (check) => assert.deepEqual(check({ preset: "ozlabs", docs: { index: "README.md" } }), []));
});

test("local inline, reference, image, HTML and duplicate heading links resolve", () => {
  fixture({
    "README.md": ["# Readme", "", "[Setup][guide]", "[again](docs/guide.md#setup-1 \"second setup\")", "[setext](docs/guide.md#setext)", "![image](<images/a b.png> 'title')", "[balanced](docs/file(1).md)", '<a href="docs/guide.md#custom">custom</a>', "[guide]: docs/guide.md#setup \"guide\"", "", "`[not a link](missing.md)`", "```md", "[example](missing.md)", "```", "", "    [code example](missing.md)", "<!-- [hidden](missing.md) -->"].join("\n"),
    "docs/guide.md": '# Guide\n\n## Setup\n\n## Setup\n\nSetext\n------\n\n<a id="custom"></a>\n',
    "docs/file(1).md": "# File\n", "images/a b.png": "\0",
  }, (check) => assert.deepEqual(check({ preset: "portable", docs: {} }), []));
});

test("broken paths, malformed percent escapes, outside links and unknown headings fail", () => {
  fixture({ "README.md": "[missing](gone.md)\n[heading](guide.md#absent)\n[outside](../outside.md)\n[encoding](%XX.md)\n", "guide.md": "# Here\n" }, (check) => {
    const problems = check({ preset: "portable", docs: {} });
    assert.equal(problems.length, 4);
    assert.ok(problems.every(({ rule }) => rule === "docs.links"));
    assert.deepEqual(problems.map(({ line }) => line), [1, 2, 3, 4]);
  });
});

test("nested list links are checked while fenced examples remain data", () => {
  fixture({ "README.md": "- guides\n    - [missing](missing.md)\n\n```md\n[example](missing.md)\n```\n" }, (check) => {
    const problems = check({ preset: "portable", docs: {} });
    assert.equal(problems.length, 1);
    assert.equal(problems[0].line, 2);
  });
});

test("unfinished code fences and HTML comments produce incomplete results", () => {
  fixture({ "README.md": "```md\n[hidden](missing.md)\n", "guide.md": "<!-- unfinished\n" }, (check) => {
    const problems = check({ preset: "portable", docs: {} });
    assert.equal(problems.length, 2);
    assert.ok(problems.every(({ rule, status }) => rule === "docs.syntax" && status === "incomplete"));
  });
});
