import { ToolHandlerError } from './tool-response.js';
import type { VaultReader } from './obsidian/vault-reader.js';
import type { VaultWriter } from './obsidian/vault-writer.js';
import type { WikilinkGraphIndex } from './obsidian/wikilink-graph.js';
import type { ListMatchingPaths } from './obsidian/query/index.js';
import type { VaultProvider } from './obsidian/vault-provider.js';
import type { SmartConnectionsCorpusIndex } from './obsidian/smart-connections-corpus-index.js';
import type { IVaultConfig } from '../types.js';

/** Filter vault-relative note paths down to those present on disk. */
export type FilterExistingPaths = (paths: Iterable<string>) => Promise<Set<string>>;

export interface IVaultEntry {
  name: string;
  path: string;
  smartEnvPath: string;
  reader: VaultReader;
  writer: VaultWriter;
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
   * vault's disk. The Smart Connections corpus is read-only and unwatched
   * (ADR-0006), so it can name notes deleted since the plugin last indexed;
   * every tool returning corpus-derived paths runs them through here first.
   * One implementation, so no consumer can disagree about what "exists" means
   * or forget the check entirely.
   */
  filterExisting: FilterExistingPaths;
  corpus?: SmartConnectionsCorpusIndex;
  semanticAvailable: boolean;
  semanticUnavailableReason?: string;
}

export interface IVaultEntryDeps {
  readerFactory: (opts: { vaultRoot: string }) => VaultReader;
  writerFactory: (opts: { vaultRoot: string }) => VaultWriter;
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
  corpusFactory: (opts: {
    smartEnvPath: string;
    modelKey: string;
  }) => Promise<SmartConnectionsCorpusIndex>;
  conventionsReaderFactory: (opts: { vaultRoot: string }) => () => Promise<string | null>;
  existingPathFilterFactory: (opts: { vaultRoot: string }) => FilterExistingPaths;
}

export interface IVaultRegistryConfig {
  vaults: IVaultConfig[];
  semanticEnabled: boolean;
  modelKey: string;
}

/**
 * Read-only contract every consumer (tool handlers, fan-out helpers, server
 * wiring) sees. Tests stub this interface directly; production uses
 * {@link VaultRegistry}.
 */
export interface IVaultRegistry {
  get(name: string): IVaultEntry | undefined;
  require(name: string): IVaultEntry;
  list(): IVaultEntry[];
  isMulti(): boolean;
  names(): string[];
}

/**
 * Default registry implementation. Construct via the static async {@link create}
 * factory — building entries is async because per-vault Smart Connections
 * corpus loading involves disk I/O.
 */
export class VaultRegistry implements IVaultRegistry {
  // Lowercased-name lookup. Entry names preserve original casing for display
  // (error details, fan-out group keys, instructions). Lookup itself is
  // case-insensitive so a caller passing "obsidian" hits the entry registered
  // as "Obsidian".
  private readonly byName: Map<string, IVaultEntry>;

  private constructor(private readonly entries: ReadonlyArray<IVaultEntry>) {
    this.byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  }

  static async create(config: IVaultRegistryConfig, deps: IVaultEntryDeps): Promise<VaultRegistry> {
    const entries: IVaultEntry[] = [];
    for (const v of config.vaults) {
      const reader = deps.readerFactory({ vaultRoot: v.path });
      const graph = deps.graphFactory({ reader });
      const listMatchingPaths = deps.listMatchingPathsFactory({ reader, graph });
      const writer = deps.writerFactory({ vaultRoot: v.path });
      const provider = deps.providerFactory({
        vaultName: v.name,
        vaultRoot: v.path,
        reader,
      });
      const readConventions = deps.conventionsReaderFactory({ vaultRoot: v.path });
      const filterExisting = deps.existingPathFilterFactory({ vaultRoot: v.path });

      let corpus: SmartConnectionsCorpusIndex | undefined;
      let semanticAvailable = false;
      let semanticUnavailableReason: string | undefined;
      if (config.semanticEnabled) {
        try {
          corpus = await deps.corpusFactory({
            smartEnvPath: v.smartEnvPath,
            modelKey: config.modelKey,
          });
          const snap = await corpus.snapshot();
          if (snap.sources.size === 0) {
            semanticUnavailableReason = 'Smart Connections corpus is empty';
            corpus = undefined;
          } else {
            semanticAvailable = true;
          }
        } catch (err) {
          semanticUnavailableReason = err instanceof Error ? err.message : String(err);
          corpus = undefined;
        }
      }

      entries.push({
        name: v.name,
        path: v.path,
        smartEnvPath: v.smartEnvPath,
        reader,
        writer,
        provider,
        graph,
        listMatchingPaths,
        readConventions,
        filterExisting,
        corpus,
        semanticAvailable,
        semanticUnavailableReason,
      });
    }
    return new VaultRegistry(entries);
  }

  get(name: string): IVaultEntry | undefined {
    return this.byName.get(name.toLowerCase());
  }

  require(name: string): IVaultEntry {
    const entry = this.byName.get(name.toLowerCase());
    if (entry) return entry;
    throw new ToolHandlerError('VAULT_NOT_FOUND', `Vault "${name}" is not registered`, {
      details: { requested: name, registered_vaults: this.names() },
    });
  }

  list(): IVaultEntry[] {
    return [...this.entries];
  }

  names(): string[] {
    return this.entries.map((e) => e.name);
  }

  isMulti(): boolean {
    return this.entries.length > 1;
  }
}
