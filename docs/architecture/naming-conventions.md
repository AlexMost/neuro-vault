# Naming Conventions

How TypeScript symbols are named in this codebase, and where related types live within the file tree.

## Interfaces use the `I` prefix

New interface declarations get the `I` prefix: `IVaultEntry`, `ITool`, `IResource`, `IFanOutResult`. This makes it visually obvious in import lists which symbols are structural contracts vs. concrete implementations:

```ts
import { VaultRegistry, type IVaultRegistry } from './lib/vault-registry.js';
//        ^^^^^^^^^^^^^       ^^^^^^^^^^^^^^^
//        class (runtime)     interface (contract)
```

This matches the pre-existing `ITool` / `IResource` convention introduced earlier in the codebase. Pre-existing interfaces without the prefix are not renamed unless they are touched by an ongoing change for another reason.

## Classes do not use the `I` prefix

Where both an interface and a default implementation exist, the class drops the prefix and `implements` the interface:

```ts
export interface IVaultRegistry {
  get(name: string): IVaultEntry | undefined;
  // ...
}

export class VaultRegistry implements IVaultRegistry {
  // ...
}
```

Consumers depend on the interface (`registry: IVaultRegistry` in function signatures). The class is the default runtime implementation. This split makes substituting an alternative implementation — or stubbing in tests via an object literal that satisfies the interface — cheap.

## One file per concept, not per type

Co-locate small related types in the same file as the concept they describe. For example, `src/lib/vault-registry.ts` holds:

- `IVaultEntry` — per-vault primitive bundle
- `IVaultEntryDeps` — factories the registry consumes at construction
- `IVaultRegistryConfig` — registry-wide config
- `IVaultRegistry` — public read-only contract
- `class VaultRegistry implements IVaultRegistry` — default implementation

Five symbols, one file, one concept. Splitting them into five files would inflate the import surface without improving cohesion — anyone reading or modifying registry behaviour needs all of these in context at once.

Split into separate files only when:

- The same interface is reused across modules and lives in `src/lib/` as a shared primitive.
- The file grows beyond what's easy to hold in context (rule of thumb: ~300 lines for a focused module).

"One interface per file" is the wrong default for a small TypeScript codebase.
