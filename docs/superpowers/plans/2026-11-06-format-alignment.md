# Aligned Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `plumb check`/`plumb fix` align Markdown tables and `KEY # comment` files, sort listed JSON keys, and run pinned formatters for Prisma, shell, SQL and TOML, in any repository.

**Architecture:** A dependency-free core module (`src/align.mjs`) holds the pure aligners. A core check (`src/formatting.mjs`) applies them to selected files and plugs into the engine and `fix` like `comments.mjs` does. The JavaScript pack chains the table aligner after Prettier for Markdown, so both produce one layout. Pinned external formatters become steps (`src/format-tools.mjs`) executed by the existing `executeSteps`, whose `tools.versions` pinning and `tools.missing`/`tools.version` diagnostics already exist.

**Tech Stack:** Node ≥ 22.18 ESM, `node:test`, no new core dependencies; external binaries `prisma`, `shfmt`, `sql-formatter`, `taplo`.

**Spec:** `docs/superpowers/specs/2026-11-06-format-alignment-design.md`

## Global Constraints

- The core stays dependency-free: nothing new in the root `package.json` dependencies.
- No network during `check`; external tools come from `PATH`, then `<project root>/node_modules/.bin`.
- Tool versions are pinned through the existing `tools.versions` map (the spec's per-entry pin is expressed there, so `executeSteps` enforces it unchanged).
- Core aligners are on for `preset: "ozlabs"` and off for `preset: "portable"`. External tools run only when listed in `format.tools`.
- `exclude` and `format.ignore` apply to every new formatter.
- `fix` run twice produces no further change (idempotency) for every formatter.
- Rule IDs: `format.markdown-table`, `format.key-columns`, `format.json-keys`, `format.prisma`, `format.shell`, `format.sql`, `format.toml`.
- Style: match the existing modules (dense single-line ESM, `node:test` + `node:assert/strict`).

## Review Focus

- A `|` inside inline code or escaped as `\|` in a table cell must not split a cell. Tested in Task 1.
- A table inside a fenced code block, and a pipe line that is not a table (no delimiter row), stay byte-identical. Tested in Task 1.
- A `#` inside a quoted value or a URL in a `KEY` file is not a comment, and an unparseable line is untouched. Tested in Task 1.
- Markdown in a repo with a JavaScript project converges: `fix` then `check` reports nothing for a table wider than 100 columns. Tested in Task 4.
- A selected file a pinned tool cannot parse reports an incomplete `format.<kind>` diagnostic, never a silent pass. Tested in Task 5.

---

### Task 1: Pure aligners

**Files:**
- Create: `src/align.mjs`
- Test: `test/align.test.mjs`

**Interfaces:**
- Produces: `displayWidth(text: string): number`; `alignMarkdownTables(source: string): string`; `alignKeyColumns(source: string): string`; `sortJsonKeys(source: string, depth?: number): string` (default `depth = 1`).

- [ ] **Step 1: Write the failing tests** in `test/align.test.mjs`:
  - `displayWidth`: `"abc"` → 3, `"日本"` → 4, `"é"` → 1, `"🙂"` → 2.
  - `alignMarkdownTables("| a | bb |\n|---|:-:|\n| ccc | d |\n")` === `"| a   | bb  |\n| --- | :-: |\n| ccc |  d  |\n"` (centre marker centres the cell, `---:` right-aligns, default left).
  - A 3-column table whose aligned rows exceed 100 characters is still padded (assert every row has equal `displayWidth`).
  - Cells containing `` `a|b` `` and `a \| b` keep one cell each.
  - Text inside a ```` ``` ```` fence and a pipe line with no delimiter row are returned unchanged.
  - Idempotency: `alignMarkdownTables(alignMarkdownTables(x)) === alignMarkdownTables(x)` for the fixtures above.
  - `alignKeyColumns("A string # one\nLONG_NAME nonEmpty # two\n")` === `"A         string   # one\nLONG_NAME nonEmpty # two\n"`.
  - Runs break at a blank line and at a full-line comment; each run aligns on its own.
  - `NAME=value # c` lines pad only the comment column; `NAME=value` text is unchanged.
  - `URL "a # b" # real` treats only the last `#` as a comment; `URL=http://x/#frag` has no comment; a line without a comment does not widen the comment column.
  - `sortJsonKeys('{"b":1,"a":{"d":1,"c":2}}\n')` sorts top-level only (`a` before `b`, `d` before `c` kept); with `depth = 2` both levels are sorted; arrays keep order; output is `JSON.stringify(value, null, 2) + "\n"`.

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `node --test test/align.test.mjs`. Expected: FAIL, `Cannot find module '../src/align.mjs'`.

- [ ] **Step 3: Implement the four exports in `src/align.mjs`.**
  - `displayWidth`: iterate grapheme code points; combining marks (`\p{M}`) add 0, `\p{Extended_Pictographic}` and East Asian Wide/Fullwidth ranges (CJK `ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦` and supplementary ideographs) add 2, else 1.
  - `alignMarkdownTables`: line scanner tracking fences (```` ``` ```` / `~~~`); a table is a header row followed by a delimiter row matching `/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/`; split cells on unescaped `|` outside backtick spans; pad with spaces to the column's max `displayWidth` (minimum 3 for the delimiter); delimiter cells become `-` runs keeping `:` markers; rows always use leading and trailing pipes.
  - `alignKeyColumns`: per line, parse `name`, separator (whitespace or `=`), `rest`, and a comment starting at a `#` preceded by whitespace and outside quotes; lines that do not parse are passed through unchanged and end the run.
  - `sortJsonKeys`: `JSON.parse`, recursively sort object keys with `localeCompare`-free code-point order (`a < b ? -1 : 1`) down to `depth`, `JSON.stringify(…, null, 2) + "\n"`.

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `node --test test/align.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit**
  `git add src/align.mjs test/align.test.mjs && git commit -m "feat: add dependency-free table, key-column and JSON key aligners"`

### Task 2: Policy schema

**Files:**
- Modify: `src/config.mjs:45` (the `format` object)
- Regenerate: `plumb.schema.json`
- Test: `test/kernel.test.mjs` (config validation cases live there; add to it)

**Interfaces:**
- Produces: `config.format.keyColumns?: string[]` (globs; default when absent: `["**/.env.schema", "**/.env.example"]`), `config.format.sortKeys?: { files: string[], depth?: integer ≥ 1 }[]`, `config.format.tools?: { tool: "prisma" | "shfmt" | "sql-formatter" | "taplo", files: string[], dialect?: string }[]` (`dialect` only for `sql-formatter`, default `"postgresql"`).

- [ ] **Step 1: Write the failing tests**: `loadConfig` accepts a policy with all three keys; it rejects `format.tools[0].tool = "black"`, `sortKeys[0].depth = 0`, and `dialect` on a non-`sql-formatter` entry (assert the error message names the path).
- [ ] **Step 2: Run** `node --test test/kernel.test.mjs`. Expected: FAIL on the new cases.
- [ ] **Step 3: Extend the `format` object schema** in `src/config.mjs` with the three properties above (the `dialect` rule as a validation check after schema validation, beside the existing project checks), then run `node scripts/schema.mjs` to regenerate `plumb.schema.json`.
- [ ] **Step 4: Run** `node --test test/kernel.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/config.mjs plumb.schema.json test/kernel.test.mjs && git commit -m "feat: add format key-column, sort-key and tool policy"`

### Task 3: Core formatting check and fix

**Files:**
- Create: `src/formatting.mjs`
- Modify: `src/engine.mjs` (import; add to `coreRules()` module list; add `{ id: "formatting", adapter: "core", root: ".", capability: "formatting", files: formattingFiles(ctx), evidence: "content" }` to `core` in `executionPlan`; `await execute("formatting", () => formatting.checkFormatting(ctx), formattingFiles(ctx).length > 0)` after `comments`)
- Modify: `src/cli.mjs` `conservativeFix` (run `fixFormatting(ctx)` first, before the JavaScript pack)
- Test: `test/formatting.test.mjs`

**Interfaces:**
- Consumes: Task 1 aligners; Task 2 `config.format`.
- Produces: `RULES` (`format.markdown-table`, `format.key-columns`, `format.json-keys`, each `suppressible: true`, remedy `"Run plumb fix and review the alignment."`); `formattingFiles(ctx): string[]`; `expectedLayout(ctx, path: string, source: string): string`; `checkFormatting(ctx): Diagnostic[]`; `fixFormatting(ctx): { diagnostics: Diagnostic[], written: string[] }`.

- [ ] **Step 1: Write the failing tests** using a temp repository built in the test (pattern from `test/comments.test.mjs` / `test/workflow.test.mjs`):
  - `ozlabs`, no JS project: a misaligned `README.md` table yields one `format.markdown-table` diagnostic; `fixFormatting` rewrites it; a second `checkFormatting` yields none.
  - `ozlabs` with a `typescript` project: `formattingFiles` excludes `*.md` (the pack owns Markdown).
  - `portable`: `formattingFiles` is empty for the same files.
  - `api/.env.schema` misaligned → `format.key-columns`; with `format.keyColumns: ["config/*.keys"]` only that glob is selected.
  - `format.sortKeys: [{ files: ["plumb.json"] }]` with unsorted keys → `format.json-keys`; a file outside the list is never touched.
  - A path matched by `exclude` or `format.ignore` is never selected; `ctx.ownedFiles` (generated assets) are never selected.
- [ ] **Step 2: Run** `node --test test/formatting.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/formatting.mjs`.** `formattingFiles` selects, when `preset === "ozlabs"`: `*.md` files (only if no project has profile `typescript` or `react`), files matching `format.keyColumns` (default above); and, for any preset, files matching `format.sortKeys[].files`; minus owned files and `format.ignore`. `expectedLayout` applies `sortJsonKeys` (with the entry's `depth`), then `alignKeyColumns` or `alignMarkdownTables` by selection. `checkFormatting` compares `expectedLayout` with the file for tables and key columns. For `sortKeys` files it compares only the key sequence at each level up to `depth` (parse both), because Prettier owns JSON whitespace in a JS repo and a byte comparison would make the two fight. `fixFormatting` writes only paths in `ctx.writableFiles`, and runs before the JavaScript pack, so Prettier re-prints the sorted JSON. Wire engine and CLI as listed under Files.
- [ ] **Step 4: Run** `node --test test/formatting.test.mjs && node scripts/test.mjs unit`. Expected: PASS, and no existing test regresses.
- [ ] **Step 5: Commit** `git add src/formatting.mjs src/engine.mjs src/cli.mjs test/formatting.test.mjs && git commit -m "feat: check and fix aligned tables, key columns and JSON key order"`

### Task 4: Prettier chaining in the JavaScript pack

**Files:**
- Modify: `package.json` (`exports["./align"] = "./src/align.mjs"`)
- Modify: `packages/javascript/index.mjs` `format()` (after `prettier.format`, when `info.inferredParser === "markdown"`, apply `alignMarkdownTables` from `@ozlabs/plumb/align`)
- Test: `packages/javascript/test/adapter.test.mjs`

**Interfaces:**
- Consumes: `alignMarkdownTables` (Task 1).
- Produces: the pack's Markdown layout = `alignMarkdownTables(prettier(source))`; diagnostics keep the rule `javascript/format`.

- [ ] **Step 1: Write the failing test**: a `typescript` project repo with a `docs/guide.md` table whose aligned rows exceed 100 characters; run the pack's `fix` then `check`; assert no `javascript/format` diagnostic for `docs/guide.md` and every table row has equal `displayWidth`; running `fix` again writes nothing.
- [ ] **Step 2: Run** `node --test packages/javascript/test/adapter.test.mjs`. Expected: FAIL (Prettier compacts the wide table).
- [ ] **Step 3: Implement the chaining** in `format()` exactly as described under Files; add the `./align` export.
- [ ] **Step 4: Run** `npm run test:javascript`. Expected: PASS.
- [ ] **Step 5: Commit** `git add package.json packages/javascript/index.mjs packages/javascript/test/adapter.test.mjs && git commit -m "feat: keep wide Markdown tables aligned after Prettier"`

### Task 5: Pinned external formatters

**Files:**
- Create: `src/format-tools.mjs`
- Modify: `src/engine.mjs` (planned check `{ id: "format-tools", … files: formatToolFiles(ctx) }`; run `processExecuteSteps(ctx, formatToolSteps(ctx, "check"))` inside `execute("format-tools", …)` and merge its diagnostics; add `RULES` to `coreRules()`)
- Modify: `src/cli.mjs` `conservativeFix` (run `executeSteps(ctx, formatToolSteps(ctx, "fix"))` after the native steps)
- Test: `test/format-tools.test.mjs`

**Interfaces:**
- Consumes: Task 2 `config.format.tools`; `executeSteps(ctx, steps, execute)` from `src/process.mjs`.
- Produces: `RULES` (`format.prisma`, `format.shell`, `format.sql`, `format.toml`, `suppressible: false`); `formatToolFiles(ctx): string[]`; `formatToolSteps(ctx, mode: "check" | "fix"): Step[]`, one step per tool entry with `{ id: "format.<kind>", rule, tool, path: ".", cwd: ctx.root, command, versionCommand, fix, files }`.

Commands (selected files are root-relative paths; `<bin>` resolves to `<tool>` on `PATH`, else `<root>/node_modules/.bin/<tool>` if it exists):

| Tool            | Rule          | Check command                                             | Fix command                                       | Version command               |
| --------------- | ------------- | --------------------------------------------------------- | ------------------------------------------------- | ----------------------------- |
| `prisma`        | `format.prisma` | `<bin> format --check --schema <file>` (one step per schema folder or file) | `<bin> format --schema <file>` | `<bin> --version`             |
| `shfmt`         | `format.shell`  | `<bin> -i 2 -d <files>`                                   | `<bin> -i 2 -w <files>`                           | `<bin> --version`             |
| `sql-formatter` | `format.sql`    | `<bin> --language <dialect> --check <files>`              | `<bin> --language <dialect> --fix <files>`        | `<bin> --version`             |
| `taplo`         | `format.toml`   | `<bin> fmt --check <files>`                               | `<bin> fmt <files>`                               | `<bin> --version`             |

- [ ] **Step 1: Write the failing tests** with a fake `execute` passed to `executeSteps` (record commands, return chosen codes):
  - Each tool builds the check and fix commands in the table for its matched files, excluding `exclude`/`format.ignore` paths.
  - A `format.tools` entry whose globs match nothing produces an `incomplete` `format.<kind>` diagnostic ("matches no selected files").
  - Exit code 1 → `violation` with the tool's rule; exit code ≥ 2 or spawn error → `incomplete` (proves a parse failure is never a silent pass).
  - A failing version probe → `tools.missing`; a mismatching `tools.versions.shfmt` → `tools.version`.
  - Binary resolution prefers `PATH`, falls back to `node_modules/.bin`.
- [ ] **Step 2: Run** `node --test test/format-tools.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/format-tools.mjs`** per the table and wire engine and CLI as listed under Files.
- [ ] **Step 4: Run** `node --test test/format-tools.test.mjs && node scripts/test.mjs unit`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/format-tools.mjs src/engine.mjs src/cli.mjs test/format-tools.test.mjs && git commit -m "feat: run pinned Prisma, shell, SQL and TOML formatters"`

### Task 6: Documentation and self-check

**Files:**
- Create: `docs/formatting.md`
- Modify: `packages/javascript/README.md` ("Repair and review": Markdown tables stay aligned after Prettier)

- [ ] **Step 1: Write `docs/formatting.md`**: what each aligner does, the `ozlabs`/`portable` difference, `format.keyColumns` / `format.sortKeys` / `format.tools` with one example policy, the tool table from Task 5, and that pins live in `tools.versions`.
- [ ] **Step 2: Run** `node bin/plumb.mjs fix && node bin/plumb.mjs fix && git diff --exit-code docs/` and `node scripts/test.mjs`. Expected: no diff on the second `fix` (the docs' own tables are aligned) and all suites pass.
- [ ] **Step 3: Commit** `git add docs/formatting.md packages/javascript/README.md && git commit -m "docs: describe aligned formatting and pinned format tools"`
