> **Parallel-safety**: groups 1 → 2 → 3 are **sequential** (each builds on the
> previous file's shape). Group 4 (docs) is **parallel-safe** with group 3 —
> different files, no shared state. Group 5 is the final sequential gate.

## 1. Single version source

_Sequential — everything downstream imports this module._

- [x] 1.1 Write a failing test asserting a `packageMeta` export reports the same
      `name` and `version` as the repo's `package.json` (read the manifest in the
      test independently, so the assertion is a real comparison).
- [x] 1.2 Add `src/package-meta.ts` exporting `{ name, version }` via
      `createRequire(import.meta.url)` + `require('../package.json')`. Place it at
      `src/` root depth — **not** under `src/lib/`. Add a comment at the `require`
      site recording why: tsup flattens the bundle into `dist/cli.js` and never
      rewrites the literal path string, so `'../package.json'` must resolve to the
      package root from both `src/` and `dist/`, which only holds at equal depth
      (design.md D5).
- [x] 1.3 Refactor `src/server.ts` to import `packageMeta` instead of running its
      own `createRequire` read; delete the local `require('../package.json')`.
      Confirm the existing server tests still pass — the MCP identity is unchanged.
- [x] 1.4 Verify no other module reads `package.json` at runtime
      (`grep -rn "package.json" src/`), satisfying the "No second manifest read"
      scenario.

## 2. Representable early exit in `parseConfig`

_Sequential — depends on group 1 for the version string._

- [x] 2.1 Write failing tests in `test/config.test.ts`: `--version` resolves to the
      "handled" variant, and `--help` resolves to the "handled" variant — neither
      throws `--vault is required`.
- [x] 2.2 Introduce the `ParsedCli` discriminated union
      (`{ kind: 'run'; config: ServerConfig } | { kind: 'handled' }`) and change
      `parseConfig`'s return type to `Promise<ParsedCli>` (design.md D4).
- [x] 2.3 Replace `.version(false)` with `.version(packageMeta.version)` so yargs
      prints the bare number (design.md D1).
- [x] 2.4 After `.parse()`, return `{ kind: 'handled' }` when
      `args.help === true || args.version === true`, before the `rawVaults.length`
      guard. Wrap the existing success path in `{ kind: 'run', config }`
      (design.md D3).
- [x] 2.5 Update the ~12 existing `parseConfig` assertions in `test/config.test.ts`
      for the new shape (mechanical — let `npx tsc --noEmit` enumerate them).
      Keep the "missing vault is still an error" case asserting a throw.

## 3. Entry point honours the short-circuit

_Sequential — depends on group 2._

- [x] 3.1 Write a failing test for `main()` proving that with `--version` (and
      again with `--help`) the injected server factory and transport factory are
      **never** invoked — this is the "informational flag never opens the
      transport" scenario, and it is what keeps stdout's JSON-RPC channel clean.
      Use the existing `NeuroVaultStartupDependencies` DI seam, not module mocks.
- [x] 3.2 In `src/cli.ts`, return early from `main()` when `parseConfig` yields
      `{ kind: 'handled' }`; otherwise pass `result.config` to
      `startNeuroVaultServer`. Leave `process.exitCode` untouched so the process
      exits 0.
- [x] 3.3 Confirm the `run()` error path is unchanged: a thrown config error still
      prints to stderr and sets `process.exitCode = 1`.

## 4. Documentation

_Parallel-safe with group 3 — separate files._

- [x] 4.1 Add `docs/architecture/cli-startup.md`: the entry-point flow
      (`cli.ts` → `parseConfig` → `startNeuroVaultServer`), why `.exitProcess(false)`
      requires the caller to act on the parser's signal, the `ParsedCli` contract,
      and the `src/`-depth constraint on `package-meta.ts`. Link it from
      `docs/architecture/README.md`.
- [x] 4.2 Add a `--version` row to the CLI argument table in
      `docs/guide/configuration.md` (the only flag table in the repo today — the
      `--vault` mentions in `README.md` and `docs/guide/installation.md` are
      command examples, not listings). Then sweep all of `docs/` and `README.md`
      for any other flag listing rather than trusting that inventory.

## 5. Verification gate

_Sequential — runs last, after every other group._

- [x] 5.1 Run `npm test`, `npm run lint`, and `npm run typecheck` — all three must
      pass (AGENTS.md; `tsc --noEmit` is authoritative, not the tsup build).
- [x] 5.2 Run `npm run build`, then verify against the **build output**:
      `node dist/cli.js --version` prints the `package.json` version and exits 0,
      and `node dist/cli.js --help` exits 0 with no trailing `--vault is required`.
      This is the one failure mode no source-level test can catch (design.md D5 risk).
- [x] 5.3 Run `npm run format` and `npx openspec validate cli-version-flag`.
