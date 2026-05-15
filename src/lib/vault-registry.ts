import { ToolHandlerError } from './tool-response.js';
import type { VaultReader } from './obsidian/vault-reader.js';
import type { VaultWriter } from './obsidian/vault-writer.js';
import type { WikilinkGraphIndex } from './obsidian/wikilink-graph.js';
import type { ListMatchingPaths } from './obsidian/query/index.js';
import type { VaultProvider } from './obsidian/vault-provider.js';
import type { SmartConnectionsCorpusIndex } from './obsidian/smart-connections-corpus-index.js';
import type { VaultConfig } from '../types.js';

export interface VaultEntry {
  name: string;
  path: string;
  smartEnvPath: string;
  reader: VaultReader;
  writer?: VaultWriter;
  provider?: VaultProvider;
  graph: WikilinkGraphIndex;
  listMatchingPaths: ListMatchingPaths;
  corpus?: SmartConnectionsCorpusIndex;
  semanticAvailable: boolean;
  semanticUnavailableReason?: string;
}

export interface VaultEntryDeps {
  readerFactory: (opts: { vaultRoot: string }) => VaultReader;
  writerFactory: (opts: { vaultRoot: string }) => VaultWriter;
  graphFactory: (opts: { reader: VaultReader }) => WikilinkGraphIndex;
  listMatchingPathsFactory: (opts: {
    reader: VaultReader;
    graph: WikilinkGraphIndex;
  }) => ListMatchingPaths;
  providerFactory: (opts: { vaultName: string; binaryPath?: string }) => VaultProvider;
  corpusFactory: (opts: {
    smartEnvPath: string;
    modelKey: string;
  }) => Promise<SmartConnectionsCorpusIndex>;
}

export interface VaultRegistryConfig {
  vaults: VaultConfig[];
  operationsEnabled: boolean;
  semanticEnabled: boolean;
  modelKey: string;
  binaryPath?: string;
}

export interface VaultRegistry {
  get(name: string): VaultEntry | undefined;
  require(name: string): VaultEntry;
  list(): VaultEntry[];
  isMulti(): boolean;
  names(): string[];
  semanticAvailableEntries(): VaultEntry[];
}

export async function createVaultRegistry(
  config: VaultRegistryConfig,
  deps: VaultEntryDeps,
): Promise<VaultRegistry> {
  const entries: VaultEntry[] = [];
  for (const v of config.vaults) {
    const reader = deps.readerFactory({ vaultRoot: v.path });
    const graph = deps.graphFactory({ reader });
    const listMatchingPaths = deps.listMatchingPathsFactory({ reader, graph });
    const writer = config.operationsEnabled ? deps.writerFactory({ vaultRoot: v.path }) : undefined;
    const provider = config.operationsEnabled
      ? deps.providerFactory({ vaultName: v.name, binaryPath: config.binaryPath })
      : undefined;

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

  const byName = new Map(entries.map((e) => [e.name, e]));

  return {
    get: (name) => byName.get(name),
    require: (name) => {
      const e = byName.get(name);
      if (e) return e;
      throw new ToolHandlerError('VAULT_NOT_FOUND', `Vault "${name}" is not registered`, {
        details: { requested: name, registered_vaults: entries.map((x) => x.name) },
      });
    },
    list: () => [...entries],
    names: () => entries.map((e) => e.name),
    isMulti: () => entries.length > 1,
    semanticAvailableEntries: () => entries.filter((e) => e.semanticAvailable),
  };
}
