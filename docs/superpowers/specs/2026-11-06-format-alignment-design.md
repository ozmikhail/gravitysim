# Aligned formatting for data and schema files

## Intent

`plumb fix` should leave every file in a repository consistently laid out, not only the code a language pack formats. Tables, schemas and configuration files get aligned columns, so they read as tables and the next change follows the same shape. `plumb check` refuses a file that differs from that layout, exactly as it does for code today.

Plumb stays usable by any repository: a Ruby, C++ or documentation-only repository gets the same alignment without installing the JavaScript pack.

## Goals

- Markdown tables are always padded into aligned columns, including tables wider than the print width, in every repository on the `ozlabs` preset.
- `KEY … # comment` files (`.env.schema`, `.env.example`, similar) have their value and comment columns aligned.
- Prisma schemas are formatted by the pinned `prisma format`.
- Shell scripts and hooks are formatted by the pinned `shfmt`.
- Non-migration SQL is formatted by a pinned SQL formatter.
- TOML is formatted (core aligner or pinned tool; see "Left to the builder").
- Selected JSON configuration files keep a stable key order.
- Every formatter is deterministic, runs offline, and reports through the existing `check`/`fix`/diagnostic flow.

## Non-goals

- Alignment inside TypeScript/JavaScript code. Prettier owns it; a competing pass would oscillate with it.
- Dockerfile formatting. The available formatters are weak; revisit when a reliable one exists.
- Formatting deployed migrations or any file a policy marks immutable.

## Anti-goals

- `plumb fix` and the JavaScript pack's Prettier undoing each other's output.
- Network access or unpinned tool versions during `check`.
- A new mandatory dependency for the core.
- Silently skipping a selected file because no formatter applies to it.

## Constraints

- The core stays dependency-free. Plumb-owned aligners are plain JavaScript in `src/`.
- External tools follow the existing native-tool model (`src/native.mjs`): pinned versions through `tools.versions`, version checks, `fix` writes and `check` dry-runs, and `tools.missing`/`tools.version` diagnostics when absent or mismatched.
- Churn is acceptable everywhere: re-padding a whole block for one longer value is intended.
- `format.ignore` and `exclude` keep working for every new formatter.

## Approaches

**A. Formatters in the core, external tools pinned and opt-in (chosen).** Plumb's own dependency-free aligners handle what plumb can own exactly: Markdown tables, `KEY` columns and JSON key order. Prisma, shell and SQL run as pinned external tools, using the same mechanism as `clang-format`, and are enabled in `plumb.json`. This works with or without the JavaScript pack. Cost: the core table pass and the JavaScript pack's Prettier both touch Markdown, so one fixed order is required.

B. Prettier plugins in the JavaScript pack, plus a table pass. Least new code, but only repositories with a JavaScript project would get any of it, which breaks "any foundation".

C. A separate optional "formats" pack with its own dependencies. Clean isolation, but a third package to version and install, while most aligners need no dependency.

The user chose A because it extends the two mechanisms plumb already has and the aligners work everywhere.

## Design decisions

1. **Ordering with Prettier.** For a file both Prettier and a core aligner handle (Markdown), the formatted result is `coreAlign(prettier(source))`, both in `fix` and when `check` computes the expected bytes. The JavaScript pack exposes its Prettier pass so the core can chain it; without the pack, the core aligner runs alone. *(The ordering was decided with the user; the API shape is my call.)*
2. **Markdown tables.** A pipe table is re-emitted with every cell padded to its column width, using display width for wide and combining characters. Alignment markers (`:---`, `:---:`, `---:`) are preserved. Tables inside code fences are untouched. The pass applies to every Markdown table regardless of the print width.
3. **`KEY` files.** Lines of the form `NAME <rest> # comment` in consecutive runs are aligned into columns. The run breaks at a blank line or a full-line comment. The selection is file-pattern based, defaulting to `**/.env.schema` and `**/.env.example`, and is configurable. *(Run-based alignment is my call; it matches how such files are grouped.)*
4. **JSON key order.** Keys are sorted only in files the policy lists. Nothing is sorted by default, because `package.json` and similar files have meaningful conventional orders. *(My call.)*
5. **External tools.** These are new file-type steps, not project profiles, enabled by a new `format.tools` policy entry. Each entry gives a tool name, a file glob and a pinned version: `prisma` → `**/*.prisma`, `shfmt` → shell globs plus listed extensionless hooks, `sql` → `**/*.sql` minus excluded migrations. Rule IDs follow the existing pattern: `format.prisma`, `format.shell`, `format.sql`. *(The policy shape is my call, mirroring `tools.versions`.)*
6. **The `ozlabs` preset.** The core aligners (tables and `KEY` files) are on by default in `ozlabs` and off in `portable`. External tools are always opt-in, because they need installed binaries. *(My call, matching how `ozlabs` adds comment rules today.)*
7. **Diagnostics.** A file that differs from the aligned layout reports `format.<kind>`, for example `format.markdown-table` or `format.key-columns`, with the remedy "Run plumb fix". It is suppressible only through a reasoned exception, like other format rules.

8. **Immutable files.** No new mechanism is added. A file is protected by the existing `exclude` or `format.ignore` entries in `plumb.json`, each with its reason. quayro-api already excludes `api/src/prisma/migrations/**` this way. Every new formatter honors both. *(Answered by the existing policy.)*
9. **Which presets get the aligners.** "Any foundation" means the aligners live in the dependency-free core, so a repository needs no language pack to use them. `ozlabs`, the default preset, turns them on. `portable` stays the deliberately minimal preset and leaves them off, as it already does for the comment wording rules. *(My call, consistent with how the presets differ today.)*
10. **One pipeline for check and fix.** The expected bytes for a file are computed by one pipeline, used identically by `check` and `fix`. If the repository has a JavaScript project, the JavaScript pack is already required (a missing pack is `tools.missing`), and Markdown goes through Prettier and then the table aligner. Without a JavaScript project, Prettier is not part of the pipeline and the aligner alone defines the layout. Because both commands share the pipeline, they cannot disagree. *(My call.)*
11. **`KEY` file grammar.** A `#` starts a comment only when whitespace precedes it and it is outside single or double quotes. In `NAME rest # comment` lines, the `rest` column and the comment column are padded. In `NAME=value` lines, only the comment column is padded, and the `NAME=value` text is never changed. A line without a comment is left as it is, and does not widen the comment column. A line that does not parse is left untouched. *(My call: it is conservative, so it cannot change a value.)*
12. **Where the tools come from.** Binaries are found on `PATH`, as for `clang-format`, then in the project's `node_modules/.bin` for npm-distributed tools such as `prisma`. A missing or wrong-version tool reports `tools.missing` or `tools.version`, which makes the check incomplete. Current Prisma releases run `format` through a bundled WebAssembly engine and need no download; if a version needs network access, the version check refuses it. *(My call.)*
13. **JSON key order policy.** `format.sortKeys` is a list of `{ files, depth }` entries. `depth` defaults to `1`, meaning top-level keys only. Keys are sorted by code point. Arrays are never reordered. Within the sorted layout, the existing formatter (Prettier or the core JSON printer) still owns whitespace. *(My call.)*
14. **Shell hook selection.** A `format.tools` entry's `files` globs select what the tool formats, including extensionless hooks such as `.githooks/*` listed explicitly. If the tool cannot parse a selected file, that is a `format.shell` incomplete diagnostic, never a silent skip. *(My call.)*

## Left to the builder

- The exact SQL formatter (for example `sql-formatter` or `pg_format`) and its dialect setting, chosen for determinism and offline use.
- TOML: a small core aligner or a pinned tool, whichever is smaller and deterministic.
- Display-width calculation for table cells, so emoji and CJK text align in a monospace view.
- Tests: passing and refused fixtures for each formatter, an idempotency check (`fix` twice gives no diff), and a test that Prettier and the table pass together converge.
- Updates to `plumb.schema.json`, the README and `plumb inspect` output for the new rules and policy keys.
