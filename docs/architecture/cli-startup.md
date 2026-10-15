# CLI Startup

How the process interprets `argv`, and how it decides whether to start the MCP server at all.

## What it is

`src/cli.ts` exports `main(argv, deps)`, the async function the entrypoint calls. `main` does exactly two things in sequence: call `parseConfig(argv)` (`src/config.ts`), then either return immediately, run the `index` command (`runIndexCommand`, `src/cli-index.ts`), run the `daemon` command (`runDaemonCommand`, `src/cli-daemon.ts`, loaded by dynamic `import()`), or call `startNeuroVaultServer(config, deps)` (`src/server.ts`) with the config that parsing produced.

`parseConfig` wraps `yargs`, declaring the `--vault`, `--semantic`, `--model` and (on `daemon` only) `--idle-timeout` options plus `.help()` and `.version(packageMeta.version)`. It returns a `ParsedCli`:

```typescript
type ParsedCli =
  | { kind: 'run'; config: ServerConfig }
  | { kind: 'index'; options: IndexCliOptions }
  | { kind: 'daemon'; options: DaemonCliOptions }
  | { kind: 'handled' };
```

`kind: 'run'` carries a validated `ServerConfig` — the normal case. `kind: 'index'` carries the options of the `index` subcommand (the vaults, the model profile and the `--prune` flag). `kind: 'daemon'` carries the options of the `daemon` subcommand (see [The `daemon` command](#the-daemon-command) below). `kind: 'handled'` means yargs itself fully satisfied the invocation (it printed `--help` or `--version` output) and there is nothing left to run.

## Why it exists

Two behaviours have to compose correctly, and getting either wrong breaks the CLI in a different way:

**`.exitProcess(false)` is correct because argument parsing is a library concern.** By default yargs calls `process.exit()` itself after printing help or a version string. That is fine for a bare script, but `parseConfig` is a function other code calls (tests call it directly with an in-memory argv), and a library function must never terminate its caller's process out from under it. `.exitProcess(false)` turns that implicit `process.exit()` into nothing — yargs still populates `args.help` / `args.version` and still prints, but control returns to `parseConfig` normally. The obligation this creates is on the caller: since yargs no longer exits for `--help`/`--version`, `parseConfig` must detect the flag on the parsed argv and represent "already handled" as data, or execution would fall through into the code that runs *after* a successful parse.

**`ParsedCli.handled` exists so that fallthrough is impossible to write.** Before this union existed, `--help` (with no `--vault`) would print the help text and then continue into the `--vault` presence check, which would throw `--vault is required` and set a non-zero exit code — a working `--help` invocation ending in a spurious error. Encoding the outcome as `{ kind: 'handled' }` moves that guarantee from "remember to check `args.help` before validating" (an easy thing to forget at a new call site) into the type: `main` cannot reach `startNeuroVaultServer` without narrowing `parsed.kind === 'run'` first.

## How it interacts

```
process.argv
  │
  ▼
cli.ts: main(argv, deps)
  │
  ▼
config.ts: parseConfig(argv)
  │  yargs parses; .help()/.version() may print and set args.help/args.version
  │  .exitProcess(false) → yargs returns instead of exiting
  │
  ├─ args.help === true or args.version === true
  │     └─ return { kind: 'handled' }
  │
  ├─ `daemon` subcommand → read [action] and --idle-timeout
  │     └─ return { kind: 'daemon', options }   (no --vault guard)
  │
  └─ otherwise: run the --vault guard, build IVaultConfig[], detect
     case-insensitive basename collisions, resolve --model to its ModelProfile
        ├─ `index` subcommand → return { kind: 'index', options }
        └─ otherwise          → return { kind: 'run', config }
  │
  ▼
cli.ts: main() branches on parsed.kind
  │
  ├─ 'handled' → return (startNeuroVaultServer is never called)
  ├─ 'daemon'  → runDaemonCommand(parsed.options), exit code from its result
  ├─ 'index'   → runIndexCommand(parsed.options), exit code from its result
  └─ 'run'     → startNeuroVaultServer(parsed.config, deps)
```

### Both invocations

The server command and `index` are two commands over the same vaults, so they share `--vault` and `--model`. Each option is declared once (`VAULT_OPTION`, `MODEL_OPTION` in `config.ts`) and attached to both commands, so the two can never drift apart in spelling, default, or validation. `--semantic` belongs to the server command only.

`--model` takes a profile key from the closed registry in `src/modules/semantic/model-profiles.ts` (`harrier-270m`, the default, `granite-97m` or `harrier-0.6b`; see [`embedding-pipeline.md`](./embedding-pipeline.md#profiles)). yargs `choices` rejects an unknown key with the allowed list before any vault is opened, and `parseConfig` resolves the key to its `ModelProfile` (`resolveModelProfile`), so nothing downstream handles an unknown key — `ServerConfig.semantic.model` and `IndexCliOptions.model` are already profiles. A repeated `--model` is rejected (`--model may be given only once`) rather than silently picking one of the values. The selection holds for the whole process: one model per run, no per-vault override.

Each model keeps its own corpus directory in a vault, so another `--model` selects another directory and discards nothing; only a change of identity within one model (a new pinned revision, say) rebuilds, and only that model's directory (see [`own-corpus.md`](./own-corpus.md#an-identity-change-within-a-model-is-a-rebuild-and-never-silent)). Give `index` the server's `--model` so it pre-warms the corpus the server serves; any other value builds a separate corpus beside it. The first run with a profile downloads its weights into the model cache (see [`embedding-pipeline.md`](./embedding-pipeline.md)).

### `index` flags and output

`index` takes `--vault` and `--model` (above) and one flag of its own, `--prune` (boolean, default off; `IndexCliOptions.prune`). It runs for each vault in turn, then exits non-zero if any vault failed.

- **`--prune`** removes the other models' corpora once the vault's reconcile has finished: every directory under `<vault>/.neuro-vault/corpus/` except the selected model's, and a leftover single-corpus `notes/` and `manifest.json` (see [`own-corpus.md`](./own-corpus.md#pruning-other-models-corpora)). It runs under the vault's reconcile lock, so it never deletes from beside a pass in progress, and it reports on stdout `pruned <vault>: removed <a>, <b>` or `pruned <vault>: nothing to remove`. A vault whose reconcile threw is not pruned, and the error prints as `index <vault>: <message>` on stderr. A vault whose reconcile returned with notes in scope but none embedded, reused or renamed (every note failed, as in an offline first run of a new model) is not pruned either: stderr says `not pruning <vault>: no note was indexed with <model_key>, so the other models' corpora are kept`. A partial failure — some notes failed, others were indexed — still prunes. It refuses, removing nothing, if the selected model's corpus has no manifest by the time the prune holds the lock (a concurrent `--prune` by another model removed it), so the vault is never left empty; that is an error like any other. An error while pruning is that vault's fatal error. A prune that has to wait for the lock prints the same wait line as the reconcile (below).
- **Waiting for another process.** Passes over one vault are serialised across processes by a lock. When `index` finds it held it writes `waiting for another neuro-vault process (pid <n>[ on <host>]) to finish with <vault>…` on stderr once per wait — the parenthesis dropped while the holder's pid is unknown, and the reconcile and a `--prune` each waiting at most once — a diagnostic, kept off the stdout that carries progress, rebuild, summary and prune lines. After waiting 30 minutes it gives up on that vault with a stderr error and a non-zero exit; re-run it once the other process is done (see [`own-corpus.md`](./own-corpus.md#concurrency-the-reconcile-lock)).

`main`'s own `run()` wrapper (the top-level `catch`) still applies on top of this: an error thrown out of `parseConfig` (an invalid `--vault` path, a duplicate basename) or out of `startNeuroVaultServer` is caught there, printed to stderr, and turned into `process.exitCode = 1`. `{ kind: 'handled' }` bypasses that path entirely — a successful `--help`/`--version` invocation exits 0.

`packageMeta` (`src/package-meta.ts`) is the single runtime reader of `package.json`, exporting `{ name, version }`. Two independent consumers read it:

- `config.ts` passes `packageMeta.version` to yargs's `.version()`, which is what `--version` prints.
- `server.ts` destructures `SERVER_NAME`/`SERVER_VERSION` from it to construct the `McpServer`'s identity (`new McpServer({ name, version }, { instructions })`) — the name and version an MCP client sees when it introspects the server.

Both reads go through the same module rather than each calling `createRequire` independently, so the CLI's `--version` output and the server's self-reported identity can never drift apart.

`packageMeta` resolves `'../package.json'` via `createRequire(import.meta.url)`, evaluated against wherever the *emitted* file ends up running from — not the source file. tsup (`tsup.config.ts`) bundles `src/cli.ts` and everything it imports into one flat `dist/cli.js`; it does not rewrite string literals, so the `'../package.json'` argument reaches the built file unchanged. That path is correct only because `src/` and `dist/` sit at the same depth under the package root: one `..` from either location lands on the package root, where `package.json` lives. `src/package-meta.ts` therefore has to stay at `src/` root depth. Moving it under a subdirectory such as `src/lib/` would still pass every source-level test — those import `package-meta.ts` from `src/`, where `'../package.json'` still resolves correctly — while breaking the published `dist/cli.js`, where the one bundled file no longer sits at the depth the literal string assumes. The failure would only surface in a user's hands, not in CI.

### The `daemon` command

`neuro-vault-mcp daemon [status|stop] [--idle-timeout <min>]` is the third command. `parseConfig` checks for it right after the help/version check and before the `--vault` guard, because the daemon takes no vault and no model, and returns `{ kind: 'daemon', options: { action, idleTimeoutMinutes } }`. `action` is `undefined` (run the daemon), `'status'` or `'stop'`; any other positional fails with the allowed list. `--idle-timeout` (default `DEFAULT_IDLE_TIMEOUT_MINUTES`, 30; `0` = never) is declared as a string option and parsed strictly as a non-negative integer, because yargs' number coercion would turn an empty value (an unset shell variable) into `0` and silently mean "never exit on idle". It is capped at `MAX_IDLE_TIMEOUT_MINUTES` (35791): above 2^31−1 ms Node fires a timer after 1 ms. A repeated `--idle-timeout` is rejected like a repeated `--model`. It is accepted, and ignored, with `status` and `stop`. `main` imports `src/cli-daemon.ts` only on this branch and sets `process.exitCode` from `runDaemonCommand`'s result. What the daemon does once running (paths, lock, protocol, idle exit, `status`/`stop`) is [`shared-daemon.md`](./shared-daemon.md).

## Boundaries

This file owns argv parsing and the decision to start the server or exit early — nothing past that line. Once `startNeuroVaultServer` builds the `McpServer` and connects its transport, [`mcp-server-shape.md`](./mcp-server-shape.md) takes over: tool/resource registration, the response/error envelope, and where the `instructions` constant lives. This file does not describe:

- Vault path validation details (`buildVaultConfig`'s absolute-path check, basename-as-alias rule, multi-vault duplicate detection) beyond what's needed to explain the `ParsedCli` union — those are `config.ts` implementation details, not startup-flow architecture.
- Anything about the `ServerConfig` shape once it's handed to `startNeuroVaultServer`, or how the semantic/operations modules consume it.
- MCP server identity beyond noting that `packageMeta` is its source; the server's construction and registration are `mcp-server-shape.md`'s territory.
