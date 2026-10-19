# ADR-0022 — Modules hand the composition root their factories through their barrels

- **Status**: Accepted
- **Date**: 2026-10-20

## Context

`src/server.ts` built every vault's `IRegisteredVaultDeps` itself (`buildDefaultVaultEntryDeps`), beside a second, partial set for `--no-semantic`. The defaults mixed two kinds of factory: ones `src/lib/` can build alone (reader, config, scope, wikilink graph, `listMatchingPaths`, conventions reader, existing-path filter) and ones whose implementation lives in a module (`FsVaultProvider` in operations; the semantic backend and the lexical reader in semantic). To build the second kind, `server.ts` imported module internals: `fs-vault-provider.ts`, `embed-queue.ts`, `provider-factory.ts`, `shared-services.ts`, `types.ts`, `vault-client/index.ts`, `lexical/index.ts`. That broke the documented rule in [`module-structure.md`](../architecture/module-structure.md), "a module exposes only `tools`", and adding one per-vault capability edited four production spots across two files (#115).

Moving the defaults beside the registry means `src/lib/` would import concretes from `src/modules/`, which `src/lib/` never does. #115 named two ways out:

- **(a)** an assembly module beside the registry, exempt from `src/lib/`'s import rule;
- **(b)** modules export the factories the server needs through their barrels.

Option (a) relocates the violation instead of removing it. The assembly file would still reach into `fs-vault-provider.ts` and `lexical/standalone-reader.ts`, and it would need a carve-out from a rule that otherwise has none. The barrel rule was already broken in practice, because a session has to be composed from something.

## Decision

**Option (b).** A module's barrel (`src/modules/<name>/index.ts`) exposes its tools, resources and `warmup`, plus what the composition root needs to build a session from it:

- **its per-vault factories**: its slice of `IRegisteredVaultDeps` (`operationsVaultFactories` with `providerFactory`; the semantic module's vault clients, or `lexicalOnlyVaultFactories` under `--no-semantic`, with `semanticBackendFactory` and `lexicalReaderFactory`);
- **its session-wide constructors**: for semantic, the daemon connection (`createSharedServices`, `SharedServicesClosedError`), the embedding provider and its queue, and `createVaultClients`.

**The defaults `src/lib/` can build live in the registry.** `defaultVaultDeps(modules, overrides)` in `src/lib/vault-registry.ts` builds those factories and takes the modules' slice (`IModuleVaultFactories`) as an argument, so `src/lib/` still imports nothing from `src/modules/`. A per-vault capability built from `src/lib/` now lands in one file: the entry field, its factory, its construction line and its default.

**`server.ts` imports a module only through its barrel**, and `eslint.config.js` enforces it with `no-restricted-imports` on `src/server.ts`. `server.ts` keeps module choice (which slice, `--no-semantic`), registration, transport and teardown.

## Consequences

- A module's barrel is the full list of what it hands the outside, so a new export there is a reviewed widening of the module's surface rather than a deep import nobody notices.
- Tests keep overriding any factory through `NeuroVaultStartupDependencies.vaultEntryDeps`, now the `overrides` argument of `defaultVaultDeps`.
- The rule is enforced for `src/server.ts` only. `src/cli-index.ts` and `src/cli-daemon.ts` still import semantic internals directly; they are composition roots too and can move onto the barrel later.
- A third module would contribute its own slice the same way. If one ever needs a per-vault factory the registry has no field for, the field, factory and construction line still go in `vault-registry.ts`, with its implementation coming from the module's slice.
