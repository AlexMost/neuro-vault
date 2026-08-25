Tracked by: #92

## Why

`neuro-vault-mcp` ships to npm and is normally launched through `npx`, yet the
binary cannot report its own version. That is the first question in every bug
report and the only way to tell whether an `npx` cache is stale — today the
answer requires digging through `node_modules`. `src/config.ts` disables the
flag outright with `.version(false)`; nothing in the commit that added it, nor
in any ADR, argues against exposing a version.

Probing the same code path turned up a live defect: `--help` prints the help
text **and then** `--vault is required`, exiting 1. `parseConfig` sets
`.exitProcess(false)` — correct for a library function — but nothing acts on
the fact that yargs already handled the invocation, so control falls through
into the `--vault` guard. `--version` would hit the identical trap, so one
short-circuit fixes both.

## What Changes

**`--version` flag**

- From: `.version(false)` — the flag is rejected by `.strict()`; there is no way
  to read the running version from the CLI.
- To: `--version` prints the bare version number from `package.json` (e.g.
  `15.4.0`) to stdout and exits 0, without requiring `--vault`.
- Reason: version reporting is table stakes for an npx-distributed binary.
- Impact: non-breaking, additive.

**`--help` exit behaviour**

- From: prints help, then prints `--vault is required: provide at least one
  vault with --vault <path>`, and exits 1.
- To: prints help only, and exits 0.
- Reason: yargs has already satisfied the invocation; the `--vault` guard should
  not run.
- Impact: non-breaking for humans; a fix for any script that gates on
  `--help`'s exit code.

**`parseConfig` return shape**

- From: `Promise<ServerConfig>` — "the CLI ended without producing a config" is
  unrepresentable, which is exactly why control fell through.
- To: a discriminated union distinguishing "run with this config" from "yargs
  already handled it, exit 0".
- Reason: makes the fall-through impossible by construction rather than
  unlikely by inspection.
- Impact: internal only — `parseConfig` is not part of the published API
  surface (`exports` points at `dist/cli.js`). Call sites in tests update
  mechanically, compiler-guided.

**Single version source**

- From: `src/server.ts` reads `package.json` for the MCP server identity; the
  CLI would need its own read.
- To: one shared module supplies `{ name, version }` to both.
- Reason: two independent reads of the same value drift.
- Impact: internal refactor, no behaviour change to the MCP identity.

## Capabilities

### New Capabilities

- `cli-startup-flags`: how the command-line entry point handles informational
  flags — which flags exist, what they emit, and the rule that a flag yargs has
  already satisfied terminates startup cleanly instead of falling through into
  configuration validation.

### Modified Capabilities

<!-- none — no existing spec covers CLI startup behaviour -->

## Impact

- **Code**: `src/config.ts` (enable `.version`, short-circuit, new return type),
  `src/cli.ts` (honour the short-circuit), `src/server.ts` (consume the shared
  version module), plus a new `src/package-meta.ts`.
- **Build constraint**: `src/package-meta.ts` must sit at `src/` root depth. tsup
  flattens the bundle into `dist/cli.js` and `createRequire` resolves the literal
  `'../package.json'` against the *emitted* file, so a module one directory
  deeper would resolve correctly from source and break in the published tarball.
- **Tests**: `test/config.test.ts` — new coverage for both flags; existing
  assertions updated for the new return shape.
- **Docs**: `README.md`, `docs/guide/installation.md`,
  `docs/guide/configuration.md` document the CLI flag surface and gain
  `--version`.
- **Dependencies**: none added — yargs already implements `.version()`.
- **MCP surface**: unchanged. No tool contract, parameter, or error code moves.
