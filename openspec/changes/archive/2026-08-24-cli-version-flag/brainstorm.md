<!-- Raw capture of superpowers:brainstorming output (bounded path). -->

# Brainstorm — `--version` for the `neuro-vault-mcp` CLI

**Path classification:** bounded. The flow being changed already exists in the
repo (`src/config.ts` builds the whole yargs parser); this adds one flag to it
and fixes a fall-through on the neighbouring flag.

## Background

`neuro-vault-mcp` is published to npm and installed by MCP clients (Claude Code,
Cursor, Windsurf), usually via `npx`. There is currently **no way to ask the
binary which version is running** — which is the first question in every bug
report and the only way to tell whether an `npx` cache is stale.

Version is *not* absent by accident. `src/config.ts:67` carries an explicit
`.version(false)`, added in `a6e0ae2` ("feat: use yargs for CLI arg parsing with
--help support"). Nothing in that commit or in the ADRs argues against exposing
a version — the flag was simply switched off with the rest of the yargs
defaults. There is no decision to overturn, only one to make.

The version string itself already exists in the process. `src/server.ts:22-26`
reads it to build the MCP server identity:

```ts
const require = createRequire(import.meta.url);
const { name: SERVER_NAME, version: SERVER_VERSION } = require('../package.json');
```

So the CLI would be surfacing a value the server already reports over MCP —
`--version` just makes it reachable before the transport connects.

## Discovered defect — `--help` already falls through

Probing the current binary turned up a live bug in the same code path:

```
$ npx tsx src/cli.ts --help
neuro-vault-mcp --vault <path> [--vault <path> ...]
... full help text ...
--vault is required: provide at least one vault with --vault <path>
$ echo $?
1
```

Cause: `parseConfig` sets `.exitProcess(false)` (correct — a library function
must not kill the process), but nothing acts on the fact that yargs *handled*
the invocation. yargs prints the help text and returns; control falls straight
into the `rawVaults.length === 0` guard, which throws. The user gets help
followed by a spurious error and a failing exit code.

`--version` would land in exactly the same trap. The two flags share one root
cause, so they get one fix.

## Decision chain

**Q1 — What should `--version` print?**
→ **The bare number: `15.4.0`.** This is the yargs default and it is
machine-readable: `npx neuro-vault-mcp --version` can be pasted into an issue or
compared in a script without parsing a prefix. Confirmed empirically that
`.version(<string>)` under `exitProcess(false)` writes exactly `9.9.9\n` to
stdout and nothing else.
*(Rejected: `neuro-vault-mcp 15.4.0` — prettier for a human, but every scripted
consumer then has to strip the name.)*

**Q2 — Is the `--help` fall-through in scope?**
→ **Yes, both are fixed here.** One short-circuit serves both flags. Shipping
`--version` without it would mean adding a *new* flag that exits 1 with a
spurious error, or fixing it only for `--version` and leaving `--help` broken
beside it. Neither is defensible when the fix is the same three lines.

**Q3 — How does the code learn that yargs already handled the invocation?**
→ **Read `argv.help` / `argv.version` off the parse result.** Probed against
the repo's own yargs version:

| invocation        | returned argv                                       |
| ----------------- | --------------------------------------------------- |
| `--help`          | `{"_":[],"help":true,"$0":"neuro-vault-mcp"}`        |
| `--version`       | `{"_":[],"version":true,"$0":"neuro-vault-mcp"}`     |
| `--vault /tmp`    | `{"_":[],"vault":["/tmp"],"$0":"neuro-vault-mcp"}`   |

The keys are present only when the flag fired, so `args.help || args.version` is
an exact signal. No argv pre-scan, no string matching, no second parser.
*(Rejected: hand-rolling a pre-yargs scan of `process.argv` for `--version`. It
would duplicate yargs' alias/`--` handling and drift from the real parser.)*

**Q4 — How does the short-circuit reach the caller?**
→ **`parseConfig` returns a discriminated union** instead of always a
`ServerConfig`:

```ts
type ParsedCli =
  | { kind: 'run'; config: ServerConfig }
  | { kind: 'handled' };   // yargs printed help/version; exit 0
```

`cli.ts` returns early on `handled`, so `startNeuroVaultServer` is never
reached and the process exits 0 without connecting stdio.

This is the honest fix: "the CLI legitimately ended without producing a config"
was previously *unrepresentable* in the type, which is precisely why control
fell through into the `--vault` guard. Making the state representable makes the
fall-through impossible rather than merely unlikely.

Cost: ~12 `parseConfig` call sites in `test/config.test.ts` need `.config`
appended. Mechanical, and `tsc --noEmit` finds every one.

*(Rejected: `Promise<ServerConfig | null>`. Fewer characters, but `null` does
not say why — and a nullable return is easy to `!`-away at the call site, which
reintroduces the fall-through. Rejected: throwing a sentinel error to unwind —
using the error channel for the success path.)*

**Q5 — Where does the version string come from?**
→ **A new `src/package-meta.ts`, imported by both `config.ts` and `server.ts`.**
The value must not be read in two places and drift.

There is a sharp edge here worth recording. The existing `require('../package.json')`
works from `src/server.ts` *and* from the bundled `dist/cli.js` only because
`src/` and `dist/` sit at the same depth under the repo root. tsup flattens the
whole bundle into `dist/cli.js`, and `createRequire` resolves the literal path
string against the *emitted* file — the string is opaque to the bundler and is
never rewritten. So the shared module **must live at `src/` root depth**
(`src/package-meta.ts`, not `src/lib/package-meta.ts`); at `src/lib/` it would
need `'../../package.json'`, which resolves correctly from source but points
above the repo root once bundled — and a unit test running against `src/` would
pass while the published binary crashed.

`package.json` is always shipped by npm regardless of the `files` allowlist, so
the runtime read is safe in the published tarball.

## Design trade-offs

- **Fixing `--help` alongside `--version` widens the diff** but collapses two
  bug reports into one change. The alternative — a separate follow-up PR for a
  three-line short-circuit that this change has to introduce anyway — is more
  process for less result.
- **The union costs test churn.** Accepted: the churn is mechanical and
  compiler-guided, and the type change is the part of the fix that prevents
  regression. A future flag that ends the CLI early (`--print-config`, say)
  inherits the correct shape for free.
- **Depth coupling stays implicit in the module system.** Mitigated by a comment
  at the `require` site and by a task to verify the built `dist/cli.js` actually
  prints the version — the one failure mode no source-level test can catch.
