import { ToolHandlerError } from '../../../src/lib/tool-response.js';
import type { IVaultEntry, IVaultRegistry } from '../../../src/lib/vault-registry.js';

export function makeTestRegistry(entries: Partial<IVaultEntry>[]): IVaultRegistry {
  const list = entries.map((e) => ({ semanticAvailable: true, ...e }) as IVaultEntry);
  const byName = new Map(list.map((e) => [e.name!, e]));
  return {
    get: (n) => byName.get(n),
    require: (n) => {
      const e = byName.get(n);
      if (!e) throw new ToolHandlerError('VAULT_NOT_FOUND', `no ${n}`, { details: {} });
      return e;
    },
    list: () => list,
    names: () => list.map((e) => e.name!),
    isMulti: () => list.length > 1,
    semanticAvailableEntries: () => list.filter((e) => e.semanticAvailable),
  };
}
