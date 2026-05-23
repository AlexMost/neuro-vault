import { ToolHandlerError } from './tool-response.js';
import type { VaultReader } from './obsidian/vault-reader.js';
import type { VaultWriter } from './obsidian/vault-writer.js';
import type { WikilinkGraphIndex } from './obsidian/wikilink-graph.js';
import type { ListMatchingPaths } from './obsidian/query/index.js';
import type { VaultProvider } from './obsidian/vault-provider.js';
import type { SmartConnectionsCorpusIndex } from './obsidian/smart-connections-corpus-index.js';
import type { IVaultConfig } from '../types.js';

export interface IVaultEntry {
  name: string;
  path: string;
  smartEnvPath: string;
  reader: VaultReader;
  writer: VaultWriter;
  provider: VaultProvider;
  graph: WikilinkGraphIndex;
  listMatchingPaths: ListMatchingPaths;
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
    binaryPath?: string;
  }) => VaultProvider;
  corpusFactory: (opts: {
    smartEnvPath: string;
    modelKey: string;
  }) => Promise<SmartConnectionsCorpusIndex>;
}

export interface IVaultRegistryConfig {
  vaults: IVaultConfig[];
  semanticEnabled: boolean;
  modelKey: string;
  binaryPath?: string;
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
  semanticAvailableEntries(): IVaultEntry[];
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
        binaryPath: config.binaryPath,
      });

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

  semanticAvailableEntries(): IVaultEntry[] {
    return this.entries.filter((e) => e.semanticAvailable);
  }
}
