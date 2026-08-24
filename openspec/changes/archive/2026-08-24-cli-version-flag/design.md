## Context

`src/cli.ts` is a thin entry point: `parseConfig(argv)` → `startNeuroVaultServer(config)`.
All argument parsing lives in `src/config.ts`, which builds a yargs parser with
`.strict()`, `.help()`, `.version(false)` and `.exitProcess(false)`, then
validates the resulting `--vault` list and returns a `ServerConfig`.

Two facts about that parser drive this design.

**`.version(false)` is a switch, not a decision.** It arrived in `a6e0ae2`
("feat: use yargs for CLI arg parsing with --help support") alongside the rest
of the yargs defaults. No ADR and no commit message argues against exposing a
version. Meanwhile the value is already in the process: `src/server.ts:22-26`
reads `package.json` through `createRequire` to build the MCP server identity
`{ name, version }`. `--version` surfaces a string the server already reports
over MCP — it just makes it readable before the transport connects.

**`.exitProcess(false)` is correct but incomplete.** A function that parses
arguments must not kill the process, so suppressing yargs' built-in exit is
right. But yargs signals "I handled this invocation" only through the returned
argv, and `parseConfig` never reads that signal. When `--help` fires, yargs
prints the help text, returns, and control falls straight into the
`rawVaults.length === 0` guard:

```
$ neuro-vault-mcp --help
... full help text ...
--vault is required: provide at least one vault with --vault <path>
$ echo $?    # 1
```

`--version` would land in the identical trap. The two flags are one bug.

Constraints: strict TypeScript with `isolatedModules` (`tsc --noEmit` is
authoritative, ADR-0002); ESM, Node ≥ 20; the package is bundled by tsup into a
single flat `dist/cli.js`; consumers reach the binary through `npx`.

## Goals / Non-Goals

**Goals:**

- `neuro-vault-mcp --version` prints the version from `package.json` and exits 0
  without requiring `--vault`.
- `neuro-vault-mcp --help` exits 0 with help text and no trailing error.
- One version source shared by the CLI and the MCP server identity.
- The "yargs already handled this" state is representable in the type system, so
  a future early-exit flag cannot reintroduce the fall-through.

**Non-Goals:**

- No `-v` short alias. `-v` is ambiguous next to `--vault` and commonly means
  "verbose"; the long form is unambiguous and costs nothing at a shell.
- No richer version output (git SHA, build date, Node version, loaded model).
  A bare number is what a bug report and a staleness check need.
- No change to the MCP tool surface, parameter dictionary, error codes, or the
  server identity string itself.
- No general audit of the other yargs defaults (`.demandCommand`, completion,
  epilogue). Only the two flags that share this defect are in scope.

## Decisions

### D1: `--version` prints the bare version number

- **Choice**: stdout receives `15.4.0\n` and nothing else.
- **Rationale**: it is the yargs default and it is machine-readable — the output
  can be pasted into an issue or compared in a script with no prefix stripping.
  Verified empirically against the repo's own yargs: `.version('9.9.9')` under
  `.exitProcess(false)` writes exactly `9.9.9\n`.
- **Alternative considered**: `neuro-vault-mcp 15.4.0`. Friendlier to read, but
  it pushes a parse onto every scripted consumer for a name the caller already
  typed.

### D2: `--help` is fixed in the same change

- **Choice**: both flags short-circuit through one code path.
- **Rationale**: single root cause, single fix. Shipping `--version` alone would
  either add a brand-new flag that exits 1 with a spurious error, or fix the
  fall-through for `--version` while leaving `--help` broken three lines away.
- **Alternative considered**: a separate follow-up PR for `--help`. Rejected —
  it is more process than the three-line fix this change must introduce anyway.

### D3: detect "handled" by reading `argv.help` / `argv.version`

- **Choice**: after `.parse()`, treat `args.help === true || args.version === true`
  as "yargs satisfied this invocation".
- **Rationale**: yargs sets these keys *only* when the corresponding flag fired,
  which makes the signal exact. Probed against the version in this repo:

  | invocation     | returned argv                                       |
  | -------------- | --------------------------------------------------- |
  | `--help`       | `{"_":[],"help":true,"$0":"neuro-vault-mcp"}`        |
  | `--version`    | `{"_":[],"version":true,"$0":"neuro-vault-mcp"}`     |
  | `--vault /tmp` | `{"_":[],"vault":["/tmp"],"$0":"neuro-vault-mcp"}`   |

- **Alternative considered**: scanning `process.argv` for `--version` before
  handing off to yargs. Rejected — it would duplicate yargs' handling of
  aliases, `--`, and `--no-` negation, and drift from the real parser.

### D4: `parseConfig` returns a discriminated union

- **Choice**:

  ```ts
  export type ParsedCli =
    | { kind: 'run'; config: ServerConfig }
    | { kind: 'handled' };   // yargs printed help/version — exit 0
  ```

  `cli.ts` returns early on `'handled'`, so `startNeuroVaultServer` is never
  called and the process exits 0 without connecting stdio.
- **Rationale**: "the CLI legitimately ended without producing a config" was
  *unrepresentable*, which is exactly why control fell through into the
  `--vault` guard. Making the state representable makes the fall-through
  impossible by construction rather than unlikely by inspection — and any future
  early-exit flag inherits the correct shape.
- **Alternatives considered**: `Promise<ServerConfig | null>` — shorter, but
  `null` does not say *why*, and a nullable return invites a `!` at the call
  site that silently restores the bug. Throwing a sentinel error to unwind —
  routes the success path through the error channel.
- **Cost**: roughly a dozen `parseConfig` call sites in `test/config.test.ts`
  gain `.config`. Mechanical, and `tsc --noEmit` locates every one.
- **Blast radius**: internal. `parseConfig` is not part of the published API —
  `exports` points at `dist/cli.js`, which exports only `main`.

### D5: one version source, at `src/` root depth

- **Choice**: a new `src/package-meta.ts` exporting `{ name, version }` via
  `createRequire(import.meta.url)` + `require('../package.json')`. Both
  `config.ts` and `server.ts` import it; `server.ts` drops its own read.
- **Rationale**: two independent reads of the same value drift.
- **Why the path depth is load-bearing**: tsup flattens the whole bundle into a
  single `dist/cli.js`, and `createRequire` resolves the literal path string
  against the *emitted* file. The string is opaque to the bundler and is never
  rewritten. `'../package.json'` therefore resolves to the repo root from both
  `src/*.ts` and `dist/cli.js`, because `src/` and `dist/` sit at the same depth.
  A module at `src/lib/package-meta.ts` would need `'../../package.json'`, which
  resolves correctly from source and points *above* the package root once
  bundled — a unit test against `src/` would pass while the published binary
  crashed. The constraint gets a comment at the `require` site.
- **Note**: npm always ships `package.json` regardless of the `files` allowlist,
  so the runtime read is safe in the published tarball.

### D6: a new `cli-startup-flags` capability spec

- **Choice**: a new spec rather than an amendment to an existing one.
- **Rationale**: no spec under `openspec/specs/` covers CLI startup —
  `baseline` covers quality gates and error structure, `multi-vault-dispatch`
  and `vault-scope` cover runtime behaviour once the server is up. The
  informational-flag contract has no current owner.
- **Documentation**: a matching `docs/architecture/cli-startup.md` records the
  mechanism, so the concept is readable in exactly one file.

## Risks / Trade-offs

- **[Risk]** The `src/` vs `dist/` depth coupling in D5 is invisible to
  source-level tests: a wrong path passes `vitest` and fails only in the
  published binary. → **Mitigation**: a build-output check in the task list —
  run `npm run build` and assert `node dist/cli.js --version` prints the version.
  This is the one failure mode no unit test can catch.
- **[Risk]** `--version` writes to stdout, which for an MCP stdio server is the
  JSON-RPC channel. → **Mitigation**: the short-circuit returns before
  `startNeuroVaultServer`, so no transport is ever connected and there is no
  channel to corrupt. Covered by a test asserting the server factory is not
  invoked.
- **[Trade-off]** The union in D4 costs test churn across a dozen call sites for
  a change nominally about one flag. → Accepted: the churn is mechanical and
  compiler-guided, and the type change *is* the part that prevents regression.
- **[Trade-off]** Fixing `--help` widens the diff beyond the literal request. →
  Accepted, and confirmed with the user: it collapses two defects into one
  change and the fix is shared.
- **[Risk]** A future yargs major could stop setting `argv.help` / `argv.version`.
  → **Mitigation**: both flags are covered by tests that assert exit-0 behaviour,
  so a dependency bump that breaks the signal fails CI rather than shipping.

## Migration Plan

No deployment or data migration — this is a CLI surface addition plus a bug fix
in one process. Rollout follows the normal path: PR to `main`, then
`npm run release` on `main`.

Acceptance: `npm test && npm run lint && npm run typecheck` pass, plus the
build-output check (`npm run build` then `node dist/cli.js --version` prints the
`package.json` version and exits 0, and `node dist/cli.js --help` exits 0 with
no trailing error).

Rollback: revert the PR. The change is additive to the flag surface and touches
no persisted state, so a revert restores the prior behaviour exactly.

## Open Questions

None. Output format (D1) and the inclusion of the `--help` fix (D2) were both
settled with the user during brainstorming.
