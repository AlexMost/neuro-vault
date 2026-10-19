import { createExistingPathFilter } from '../../../src/lib/obsidian/existing-paths.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';
import { createStandaloneLexicalReader } from '../../../src/modules/semantic/lexical/index.js';
import type { VaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import type { IRegisteredVault, IVaultRegistry } from '../../../src/lib/vault-registry.js';
import { makeVaultGraph } from '../../_vault-graph.js';

// Most suites using this registry don't exercise the lexical leg of
// search_notes and never set `.reader` on their partial entries. Default to a
// reader that scans as empty so LexicalIndex.search() finds nothing rather
// than throwing on `entry.reader` being undefined. Tests that DO care about
// lexical behavior pass a real `reader` explicitly, which overrides this. The
// graph defaults to an empty one (no links, nothing resolves); a test that
// needs real links passes a `WikilinkGraphIndex` over its reader. The
// entry's `lexical` reader defaults to the standalone one over whatever
// `reader` and `graph` the entry ends up with, so a graph given for
// `backlink_count` also feeds the lexical tie-break; a test of the failure
// path passes its own `lexical`.
const emptyReader: VaultReader = {
  scan: async () => [],
  readNotes: async () => [],
};

const noConventions = async (): Promise<string | null> => null;

export function makeTestRegistry(entries: Partial<IRegisteredVault>[]): IVaultRegistry {
  const list = entries.map((e) => {
    const entry = {
      reader: emptyReader,
      graph: makeVaultGraph(),
      readConventions: noConventions,
      // Most rigs provision a real temp vault and expect real staleness
      // semantics, so the default is the production filter bound to this
      // entry's root. A suite that wants specific paths to count as missing
      // passes its own `filterExisting` instead — no temp files needed.
      filterExisting: createExistingPathFilter({ vaultRoot: e.path ?? '' }),
      ...e,
    } as IRegisteredVault;
    // Built from the merged entry so the reader and graph it reads are the
    // ones the rest of the entry shows.
    entry.lexical ??= createStandaloneLexicalReader({
      vaultRoot: entry.path ?? '',
      reader: entry.reader,
      graph: entry.graph,
    });
    return entry;
  });
  const byName = new Map(list.map((e) => [e.name, e]));
  return {
    get: (n) => byName.get(n),
    require: (n) => {
      const e = byName.get(n);
      if (!e) throw new ToolHandlerError('VAULT_NOT_FOUND', `no ${n}`, { details: {} });
      return e;
    },
    list: () => list,
    names: () => list.map((e) => e.name),
    isMulti: () => list.length > 1,
  };
}
