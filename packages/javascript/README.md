# Plumb JavaScript pack

The optional JavaScript pack adds TypeScript, React, formatting and semantic contracts to the dependency-free Plumb core. It lives in `packages/javascript` inside the Plumb folder, and the core loads it from there. Install its pinned dependencies inside the copied Plumb folder:

```sh
npm install --ignore-scripts
```

Node 22.18 or newer is required. The pack ships JavaScript modules; consumers do not need Bun or a TypeScript build step to run Plumb. Its language-tool dependencies are separate from the core package.

## Configure a project

```json
{
  "schemaVersion": 1,
  "preset": "ozlabs",
  "projects": [
    { "root": "api", "profile": "typescript", "tsconfigs": ["tsconfig.json"] },
    { "root": "web", "profile": "react", "tsconfigs": ["tsconfig.json"] }
  ]
}
```

`root: "."` selects a repository-root project. Use the `typescript` profile for backend JavaScript and TypeScript and `react` for component projects. Each project needs a readable TypeScript configuration; JavaScript projects can use `allowJs`. Selected TypeScript source must belong to a configured checking program. Nested projects use the most specific JavaScript project root.

TypeScript project references are validated and forwarded to the compiler, including references used by API snapshots. Missing, escaping or cyclic reference configurations are incomplete. List source-bearing leaf configurations explicitly in `tsconfigs`, or give each leaf its own project profile; an empty solution configuration alone does not count as source coverage. Check does not build referenced declarations. Run the configured `prepare` command when those outputs are required; missing compiler inputs or reference outputs cannot be suppressed as ordinary type errors.

The checker supplies the strict compiler options and ESLint configuration from the installed pack. Candidate ESLint config files are not loaded. Source files may not turn off checks with ESLint directives, `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, formatter-ignore or coverage-ignore comments. Use a bounded, reasoned exception in `plumb.json` for a reviewable exception.

Type-aware lint reuses the strict compiler Programs for every selected TypeScript file and JavaScript included by a configured `allowJs` program. Reports expose `typedCoverage` with project-relative `typedFiles` and `syntaxOnlyFiles`. JavaScript outside those programs still receives syntax rules, but cannot satisfy a typed-only application contract. A selected TypeScript file without exact Program coverage is incomplete. Direct use of the exported ESLint factory also needs trusted Programs; it cannot silently fall back to syntax-only TypeScript checks.

The compiler host records candidate-root file bytes, missing resolution probes and directory listings, including config inheritance and dependency metadata; changes during checking invalidate the run. Compiler inputs must remain inside the checked root, except for the installed TypeScript standard libraries. Metadata paths and symlinks are refused. When checking a nested project or using a dependency installation based on symlinks, supply a regular-file dependency export through approved `--inputs`, or check the encompassing root with regular dependencies. Standard libraries remain part of the trusted toolchain; signature snapshots additionally fingerprint their contents.

The fixed typed rules reject floating and misused promises, unsafe arguments/assignments/calls/returns/member access, non-Error throws/rejections and non-exhaustive union switches. `void promise` does not count as handling a promise. Returns of promises must be awaited, and catch callback values remain unknown until narrowed. Empty catches are refused. These rules are fixed release policy; ordinary rule blocks cannot disable them.

`plumb check --format json` emits stable IDs such as `javascript/no-console`, `javascript/max-lines` and `javascript/plumb/owners`. Parse failures, unresolved governed local imports, invalid configuration and missing tools are incomplete checks, so they cannot be hidden by an exception.

## Add application contracts as data

The optional `javascript` object applies to each JavaScript project. Its file patterns are relative to that project's root. Project roots and profiles are supplied by `projects`; rule options cannot change them.

```json
{
  "javascript": {
    "source": ["src/**/*.{ts,tsx,js,jsx}"],
    "rules": [
      {
        "files": ["src/**"],
        "rules": {
          "plumb/owners": ["error", {
            "rows": [{
              "global": "fetch",
              "owner": ["src/adapters/http.ts"],
              "message": "Send requests through the HTTP adapter."
            }]
          }],
          "plumb/keyed-numbers": ["error", {
            "keys": ["duration", "delay"],
            "message": "Use the shared motion tokens."
          }]
        }
      }
    ]
  }
}
```

Rule blocks can only add supported Plumb contracts at error severity. They cannot replace preset rules, load a plugin, extend another config, alter parser settings or disable a rule. Unknown keys and malformed rule options fail validation. Overlapping blocks enforce every applicable row.

| Contract | Configuration |
| --- | --- |
| Module boundaries | `plumb/layers`: ordered `layers` tuples and reasoned package restrictions; `plumb/plain-module`: refused packages, specifiers and extensions |
| API ownership | `plumb/owners`: owner patterns for imports, global APIs, members, constructors, dynamic imports and JSX attributes |
| Export ownership | `plumb/export-prefix`: path-to-name mappings, aliases, kinds, type exports and narrow named exceptions |
| Call shape | `plumb/literal-calls`: literal arguments and module scope; `plumb/chained-call`: required method chaining |
| Value ownership | `plumb/keyed-numbers`; `plumb-react/tokens`; `plumb-react/class-set` |
| Component contracts | `plumb-react/props`, `plumb-react/refresh-boundary`, and configured client boundaries |
| Repository style | Comments, imports-first, module spacing, optional `plumb/class-style`, and the inherited ESLint/TypeScript rules |

`plumb inspect` includes the rule schemas and effective policy. Structural contracts such as manifests, registrations, import graphs, lazy modules, value catalogues and public export snapshots live in the top-level `contracts` and `projects` fields; their paths are repository-relative.

## Scoped syntax and React options

`javascript.syntax` is an array of `{ files?, selectors }` rows. Each selector is `{ selector, message }` using ESLint's AST-selector syntax. Rows without `files` apply globally; matching rows accumulate under `javascript/plumb/syntax`. An error-factory allowance never erases another syntax restriction.

Other supported options are `logCalls` (a callee-name regular expression), `errorFactory: { message, allowIn? }`, `tailwind: { files? }`, and the file-pattern arrays `clientDirective`, `words` and `lines`. Source scopes default to `src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`. Every selected script is linted; source scopes additionally receive the 400-line limit and, for React, the top-level-await restriction.

## Positive role contracts and implementation budgets

The top-level `conventions` policy adds required structure to ordinary forbidden-pattern rules. Its paths are repository-relative. Add a role such as this alongside roles for its contract modules, domain code and tests:

```json
{
  "id": "handler",
  "files": ["src/handlers/*.ts"],
  "imports": { "allow": ["src/domain/**", "src/contracts/**", "node:*"] },
  "exports": { "require": ["handle"], "allow": ["handle"] },
  "javascript": {
    "nodes": [{
      "id": "handler-function",
      "select": { "kinds": ["function"], "names": ["handle"], "exported": true, "topLevel": true },
      "count": { "min": 1, "max": 1 }
    }],
    "assignable": [{
      "id": "handler-contract",
      "export": "handle",
      "contract": { "file": "src/contracts/handler.ts", "symbol": "Handler" },
      "tsconfig": "tsconfig.json"
    }],
    "budgets": {
      "functionLines": 40,
      "maxParameters": 3,
      "maxNesting": 3,
      "duplicateBlocks": { "minStatements": 3, "maxCopies": 1 }
    }
  }
}
```

Import allow/deny scopes match literal specifiers and resolved local paths; denial takes precedence. Static imports, reexports, require and literal dynamic imports participate. Unresolvable governed local edges and computed imports are incomplete. Export requirements use resolved ECMAScript exports, including aliases; CommonJS/export-equals contracts are incomplete.

Node selectors support `function`, `class`, `interface`, `type`, `variable`, `method`, `property` and `constructor`, with optional literal `names`, `exported` and `topLevel`. `function` means a function declaration; an exported arrow is a variable. Destructured variables count their bound identifiers. Counts specify `min` and/or `max`; required and forbidden shapes use the same assertion format. Exported selection follows compiler symbol identity, including alias exports. These are structural requirements, not arbitrary executable assertions.

Type assertions require a strict explicit tsconfig containing both selected source and the exported contract type. The exported source value must have a concrete type assignable to the contract; `any`, unresolved `unknown`, `never` and uninstantiated generic evidence cannot prove it. Compiler errors make the assertion incomplete. Assignability proves a static type relationship, not runtime behavior.

Budgets apply to function implementations, including arrows, methods, constructors and accessors. `functionLines` counts physical lines from the body start through its end, including comments and blanks; `maxParameters` counts declared parameters (a rest parameter counts once). `maxNesting` counts nested if/switch/loop/try/conditional-expression syntax within each function and resets for nested functions. An `else if` adds another syntactic level; catch/finally remain within their try level.

`duplicateBlocks` counts complete statement blocks with at least `minStatements` direct statements, within each role. Fingerprints ignore whitespace, comments and positions, while retaining identifier and literal spelling. Every group above `maxCopies` gets one diagnostic with related locations. This detects exact token duplication, not renamed-variable or semantic near-duplicates. Budgets never trigger automatic refactoring or rewrite their own thresholds.

## API and effect ownership

`plumb/owners` follows provable immutable aliases, destructuring, static computed keys and local object containers. Typed scopes also compare imported and reexported symbols through the compiler. A local variable shadowing a global API does not inherit that global's ownership rule. A governed computed key or reassigned alias whose target cannot be proved is incomplete. Unsupported runtime reflection and arbitrary higher-order dispatch remain outside a whole-program effect proof; enforce behavior separately when it matters.

## Error and asynchronous-work contracts

The optional `javascript.errorHandling` applies to its project-relative `files` scope, or all project scripts when `files` is absent:

```json
{
  "javascript": {
    "errorHandling": {
      "files": ["src/services/**"],
      "factories": [{ "from": "@app/errors", "name": "createFailure" }],
      "background": [{ "from": "@app/tasks", "name": "runBackground" }]
    }
  }
}
```

Approved factories are imported symbols, not matching function names. This mode requires thrown errors to originate from those factories, or to rethrow a caught value after it has been narrowed to an Error. Existing `errorFactory` syntax restrictions remain additive. A background wrapper must resolve to an approved imported symbol, return void and receive exactly one callback returning a promise. The wrapper's implementation must be reviewed to handle failures; its signature alone does not prove scheduling, retries or error recovery.

For a result-returning scope, add `"result": {"from": "@app/result", "name": "Result"}`. Every exported callable signature must return that resolved type directly or inside a Promise; explicit throws in the scope are refused. A similarly named local type does not satisfy the contract. Missing type information or unresolved approved symbols is incomplete. These are conventions over observable syntax/types; they cannot prove that a called library never throws.

## Public API signature contracts

Name/type export snapshots remain the default. Opt into declarations with a project setting such as:

```json
{
  "root": ".",
  "profile": "typescript",
  "surface": { "snapshot": "api.surface.json", "tsconfig": "tsconfig.json", "signatures": true }
}
```

Run `plumb snapshot` explicitly and review the proposal. Version-2 snapshots include export-condition targets and priority, canonical public declarations, reachable referenced types and compiler/library identity with type-interpretation options. Reordering conditional branches therefore changes the contract even when their target filenames are unchanged. Signatures retain overload order, parameter/return types, generic constraints, optional/readonly markers, classes, interfaces and public/protected members. Implementation bodies and unrelated private declarations are omitted; private class branding is retained without exposing private implementation details. Declaration emission stays in memory and never prepares generated source implicitly.

The contract is exact equality against the reviewed declaration graph and ordered export-routing expression, including blocked (`null`) and non-script branches. Non-script asset bytes are not a TypeScript signature contract. It detects API drift; it is not a semantic-versioning classifier or a proof of behavioral compatibility. A changed compiler/library identity may require a reviewed snapshot update. Missing outputs, unresolved dependencies, invalid declaration emission and insufficient type evidence cannot produce a passing signature check. `fix` never updates a snapshot.

Recorded modules retain their global/module augmentations and UMD namespace exports. Triple-slash path, type and lib reference directives in recorded non-library modules are currently unsupported and produce an incomplete signature check, including directives present in original source but removed by declaration emit. They are not silently discarded; use explicit module/type dependencies where possible.

The client-directive option is for directories the policy intentionally treats as client modules. Local JSX or hook detection does not prove whether a module is a server or client boundary in every framework. Plumb therefore diagnoses a missing requested marker, preserves existing markers, and never adds or deletes one automatically.

## Repair and review

`plumb fix` formats supported source files with the pack's Prettier policy. It does not run general ESLint autofixes, reorder module dependencies, alter client/server boundaries, or update expected public APIs. `plumb snapshot --project api` explicitly records a configured API surface for review. Run `plumb prepare` explicitly before checking generated declarations when the project requires code generation.

ESLint and structural contracts analyze source syntax, types and module relationships. Registration checks prove static call shapes, not exactly-once execution at runtime. Ownership rules cover the documented syntax forms; they do not prove arbitrary runtime aliasing or computed dispatch. Default API snapshots record names/type-value kinds; opt-in signature snapshots enforce the reviewed declaration graph.

Knip is an optional integration, enabled by a project's `knip` setting. Knip's own framework plugins may evaluate project tooling configuration; it is a trusted-tool integration, not a sandbox. Protect its configuration and run it only in the intended checking environment. Plumb does not use an invented static-mode switch or silently disable framework discovery.

## Development checks

```sh
node --test packages/javascript/test/lint-unit.test.mjs
npm run test:javascript
```

The first command tests config validation, scope composition, conservative visitors and real ESM evaluation order without installing language engines. The complete pack suite requires the pinned dependencies and fails explicitly when they are absent. It includes passing/refused cases for all custom rules, TypeScript resolution, full ESLint config composition, inherited-rule enforcement and semantic contracts.
