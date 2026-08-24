# CLI Startup

How the process interprets `argv`, and how it decides whether to start the MCP server at all.

## What it is

`src/cli.ts` exports `main(argv, deps)`, the async function the entrypoint calls. `main` does exactly two things in sequence: call `parseConfig(argv)` (`src/config.ts`), then either return immediately or call `startNeuroVaultServer(config, deps)` (`src/server.ts`) with the config that parsing produced.

`parseConfig` wraps `yargs`, declaring the `--vault` and `--semantic` options plus `.help()` and `.version(packageMeta.version)`. It returns a `ParsedCli`:

```typescript
type ParsedCli = { kind: 'run'; config: ServerConfig } | { kind: 'handled' };
```

`kind: 'run'` carries a validated `ServerConfig` — the normal case. `kind: 'handled'` means yargs itself fully satisfied the invocation (it printed `--help` or `--version` output) and there is nothing left to run.

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
  └─ otherwise: run the --vault guard, build IVaultConfig[], detect
     case-insensitive basename collisions
        └─ return { kind: 'run', config }
  │
  ▼
cli.ts: main() branches on parsed.kind
  │
  ├─ 'handled' → return (startNeuroVaultServer is never called)
  └─ 'run'     → startNeuroVaultServer(parsed.config, deps)
```

`main`'s own `run()` wrapper (the top-level `catch`) still applies on top of this: an error thrown out of `parseConfig` (an invalid `--vault` path, a duplicate basename) or out of `startNeuroVaultServer` is caught there, printed to stderr, and turned into `process.exitCode = 1`. `{ kind: 'handled' }` bypasses that path entirely — a successful `--help`/`--version` invocation exits 0.

`packageMeta` (`src/package-meta.ts`) is the single runtime reader of `package.json`, exporting `{ name, version }`. Two independent consumers read it:

- `config.ts` passes `packageMeta.version` to yargs's `.version()`, which is what `--version` prints.
- `server.ts` destructures `SERVER_NAME`/`SERVER_VERSION` from it to construct the `McpServer`'s identity (`new McpServer({ name, version }, { instructions })`) — the name and version an MCP client sees when it introspects the server.

Both reads go through the same module rather than each calling `createRequire` independently, so the CLI's `--version` output and the server's self-reported identity can never drift apart.

`packageMeta` resolves `'../package.json'` via `createRequire(import.meta.url)`, evaluated against wherever the *emitted* file ends up running from — not the source file. tsup (`tsup.config.ts`) bundles `src/cli.ts` and everything it imports into one flat `dist/cli.js`; it does not rewrite string literals, so the `'../package.json'` argument reaches the built file unchanged. That path is correct only because `src/` and `dist/` sit at the same depth under the package root: one `..` from either location lands on the package root, where `package.json` lives. `src/package-meta.ts` therefore has to stay at `src/` root depth. Moving it under a subdirectory such as `src/lib/` would still pass every source-level test — those import `package-meta.ts` from `src/`, where `'../package.json'` still resolves correctly — while breaking the published `dist/cli.js`, where the one bundled file no longer sits at the depth the literal string assumes. The failure would only surface in a user's hands, not in CI.

## Boundaries

This file owns argv parsing and the decision to start the server or exit early — nothing past that line. Once `startNeuroVaultServer` builds the `McpServer` and connects its transport, [`mcp-server-shape.md`](./mcp-server-shape.md) takes over: tool/resource registration, the response/error envelope, and how `instructions` is composed. This file does not describe:

- Vault path validation details (`buildVaultConfig`'s absolute-path check, basename-as-alias rule, multi-vault duplicate detection) beyond what's needed to explain the `ParsedCli` union — those are `config.ts` implementation details, not startup-flow architecture.
- Anything about the `ServerConfig` shape once it's handed to `startNeuroVaultServer`, or how the semantic/operations modules consume it.
- MCP server identity beyond noting that `packageMeta` is its source; the server's construction and registration are `mcp-server-shape.md`'s territory.
