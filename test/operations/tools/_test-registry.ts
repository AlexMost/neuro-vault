import { createExistingPathFilter } from '../../../src/lib/obsidian/existing-paths.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';
import type { VaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import type { IVaultEntry, IVaultRegistry } from '../../../src/lib/vault-registry.js';

// Most suites using this registry don't exercise the lexical leg of
// search_notes and never set `.reader` on their partial entries. Default to a
// reader that scans as empty so LexicalIndex.search() finds nothing rather
// than throwing on `entry.reader` being undefined. Tests that DO care about
// lexical behavior pass a real `reader` explicitly, which overrides this.
const emptyReader: VaultReader = {
  scan: async () => [],
  readNotes: async () => [],
};

const noConventions = async (): Promise<string | null> => null;

export function makeTestRegistry(entries: Partial<IVaultEntry>[]): IVaultRegistry {
  const list = entries.map(
    (e) =>
      ({
        reader: emptyReader,
        readConventions: noConventions,
        // Most rigs provision a real temp vault and expect real staleness
        // semantics, so the default is the production filter bound to this
        // entry's root. A suite that wants specific paths to count as missing
        // passes its own `filterExisting` instead — no temp files needed.
        filterExisting: createExistingPathFilter({ vaultRoot: e.path ?? '' }),
        ...e,
      }) as IVaultEntry,
  );
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
