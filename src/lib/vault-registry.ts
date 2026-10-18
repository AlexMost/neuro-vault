import { ToolHandlerError } from './tool-response.js';
import type { VaultReader } from './obsidian/vault-reader.js';
import type { VaultScope } from './obsidian/vault-scope.js';
import type { WikilinkGraphIndex } from './obsidian/wikilink-graph.js';
import type { ListMatchingPaths } from './obsidian/query/index.js';
import type { VaultProvider } from './obsidian/vault-provider.js';
import type { ILexicalReader } from './obsidian/lexical/index.js';
import type { ISemanticBackend } from './obsidian/semantic-backend.js';
import type { VaultConfigFile } from './obsidian/vault-config.js';
import type { IVaultConfig } from '../types.js';

/** Filter vault-relative note paths down to those present on disk. */
export type FilterExistingPaths = (paths: Iterable<string>) => Promise<Set<string>>;

export interface IRegisteredVault {
  name: string;
  path: string;
  /**
   * This vault's discovery scope (capability vault-scope): the single
   * definition of which files are visible to scan-derived surfaces.
   */
  scope: VaultScope;
  reader: VaultReader;
  provider: VaultProvider;
  graph: WikilinkGraphIndex;
  listMatchingPaths: ListMatchingPaths;
  /**
   * Best-effort read of this vault's `.neuro-vault/for-external-agents.md`,
   * bound to this entry's path. Both delivery channels — composed MCP
   * `instructions` and the `get_vault_overview` response — call this one
   * function, so they cannot disagree about the path, the trim, or what
   * "absent" means.
   */
  readConventions: () => Promise<string | null>;
  /**
   * Filter vault-relative note paths down to those still present on this
   * vault's disk. The corpus this server owns is watched, but only after a
   * debounce (design D6) and only while a reconcile pass is not already in
   * flight, so the corpus can still name a note deleted seconds ago; every
   * tool returning corpus-derived paths runs them through here first. One
   * implementation, so no consumer can disagree about what "exists" means or
   * forget the check entirely.
   */
  filterExisting: FilterExistingPaths;
  /**
   * This vault's semantic backend (design D9). Live: `status()` reflects the
   * backend's current state rather than a decision frozen at startup, so a
   * vault that was cold when the server booted can still be promoted to
   * `ready` without a restart. Absent only when the semantic module is
   * globally off (`semanticEnabled: false`) — a per-vault `semantic: false`
   * config still gets a backend, just one built `enabled: false`.
   */
  backend?: ISemanticBackend;
  /**
   * How `search_notes` reads this vault's lexical leg: one reader whether the
   * cache behind it is this process's own or the shared daemon's (design D6).
   * Present on every entry — the lexical leg runs with the semantic module off
   * and for a vault whose own `semantic` flag is false.
   */
  lexical: ILexicalReader;
}

export interface IRegisteredVaultDeps {
  readerFactory: (opts: { vaultRoot: string; scope: VaultScope }) => VaultReader;
  vaultConfigFactory: (opts: { vaultRoot: string }) => Promise<VaultConfigFile>;
  scopeFactory: (opts: { vaultRoot: string; config: VaultConfigFile }) => Promise<VaultScope>;
  graphFactory: (opts: { reader: VaultReader }) => WikilinkGraphIndex;
  listMatchingPathsFactory: (opts: {
    reader: VaultReader;
    graph: WikilinkGraphIndex;
  }) => ListMatchingPaths;
  providerFactory: (opts: {
    vaultName: string;
    vaultRoot: string;
    reader: VaultReader;
  }) => VaultProvider;
  /**
   * The vault entry reads its own scope from the vault (design D7), so the
   * backend needs only where the vault is and whether it embeds at all.
   */
  semanticBackendFactory: (opts: {
    vaultRoot: string;
    vaultName: string;
    enabled: boolean;
  }) => ISemanticBackend;
  /**
   * `enabled` is the same flag the semantic backend gets: whether this vault
   * takes part in semantic search, which a reader that shares a cache with
   * other sessions needs to know when deciding to attach.
   */
  lexicalReaderFactory: (opts: {
    vaultRoot: string;
    vaultName: string;
    reader: VaultReader;
    graph: WikilinkGraphIndex;
    enabled: boolean;
  }) => ILexicalReader;
  conventionsReaderFactory: (opts: { vaultRoot: string }) => () => Promise<string | null>;
  existingPathFilterFactory: (opts: { vaultRoot: string }) => FilterExistingPaths;
}

export interface IVaultRegistryConfig {
  vaults: IVaultConfig[];
  semanticEnabled: boolean;
}

/**
 * Read-only contract every consumer (tool handlers, fan-out helpers, server
 * wiring) sees. Tests stub this interface directly; production uses
 * {@link VaultRegistry}.
 */
export interface IVaultRegistry {
  get(name: string): IRegisteredVault | undefined;
  require(name: string): IRegisteredVault;
  list(): IRegisteredVault[];
  isMulti(): boolean;
  names(): string[];
}

/**
 * Default registry implementation. Construct via the static async {@link create}
 * factory — building entries is async because scope and config loading
 * involve disk I/O. The semantic backend itself is never awaited here: it
 * decides its own readiness live (design D9), so startup returns as soon as
 * every backend has been constructed, not once each is ready.
 */
export class VaultRegistry implements IVaultRegistry {
  // Lowercased-name lookup. Entry names preserve original casing for display
  // (error details, fan-out group keys, instructions). Lookup itself is
  // case-insensitive so a caller passing "obsidian" hits the entry registered
  // as "Obsidian".
  private readonly byName: Map<string, IRegisteredVault>;

  private constructor(private readonly entries: ReadonlyArray<IRegisteredVault>) {
    this.byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  }

  static async create(
    config: IVaultRegistryConfig,
    deps: IRegisteredVaultDeps,
  ): Promise<VaultRegistry> {
    const entries: IRegisteredVault[] = [];
    for (const v of config.vaults) {
      const vaultConfig = await deps.vaultConfigFactory({ vaultRoot: v.path });
      const scope = await deps.scopeFactory({ vaultRoot: v.path, config: vaultConfig });
      const reader = deps.readerFactory({ vaultRoot: v.path, scope });
      const graph = deps.graphFactory({ reader });
      const listMatchingPaths = deps.listMatchingPathsFactory({ reader, graph });
      const provider = deps.providerFactory({
        vaultName: v.name,
        vaultRoot: v.path,
        reader,
      });
      const readConventions = deps.conventionsReaderFactory({ vaultRoot: v.path });
      const filterExisting = deps.existingPathFilterFactory({ vaultRoot: v.path });

      // The module-level flag decides whether a vault gets a backend at all;
      // the vault-level `semantic` flag (default true) only decides whether
      // that backend is built enabled or disabled. Startup does not await any
      // backend work — a backend decides its own readiness live (design D9).
      const enabled = vaultConfig.semantic !== false;
      const backend = config.semanticEnabled
        ? deps.semanticBackendFactory({ vaultRoot: v.path, vaultName: v.name, enabled })
        : undefined;
      const lexical = deps.lexicalReaderFactory({
        vaultRoot: v.path,
        vaultName: v.name,
        reader,
        graph,
        enabled,
      });

      entries.push({
        name: v.name,
        path: v.path,
        scope,
        reader,
        provider,
        graph,
        listMatchingPaths,
        readConventions,
        filterExisting,
        backend,
        lexical,
      });
    }
    return new VaultRegistry(entries);
  }

  get(name: string): IRegisteredVault | undefined {
    return this.byName.get(name.toLowerCase());
  }

  require(name: string): IRegisteredVault {
    const entry = this.byName.get(name.toLowerCase());
    if (entry) return entry;
    throw new ToolHandlerError('VAULT_NOT_FOUND', `Vault "${name}" is not registered`, {
      details: { requested: name, registered_vaults: this.names() },
    });
  }

  list(): IRegisteredVault[] {
    return [...this.entries];
  }

  names(): string[] {
    return this.entries.map((e) => e.name);
  }

  isMulti(): boolean {
    return this.entries.length > 1;
  }
}
