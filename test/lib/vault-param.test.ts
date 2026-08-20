import { describe, expect, it } from 'vitest';

import { describeMultiVault, FAN_OUT_SUFFIX } from '../../src/lib/vault-param.js';
import type { IVaultRegistry } from '../../src/lib/vault-registry.js';

function registryOf(...names: string[]): IVaultRegistry {
  return {
    get: () => undefined,
    require: () => {
      throw new Error('unused');
    },
    list: () => names.map((name) => ({ name })) as never,
    names: () => names,
    isMulti: () => names.length > 1,
  };
}

describe('FAN_OUT_SUFFIX', () => {
  it('describes results_by_vault and failed_vaults but never skipped_vaults', () => {
    expect(FAN_OUT_SUFFIX).toContain('results_by_vault');
    expect(FAN_OUT_SUFFIX).toContain('failed_vaults');
    expect(FAN_OUT_SUFFIX).not.toContain('skipped_vaults');
  });

  it('is prefixed with the registered vault names in multi-vault mode', () => {
    const text = describeMultiVault(registryOf('alpha', 'beta'), FAN_OUT_SUFFIX);
    expect(text).toContain('Registered vaults: "alpha", "beta".');
    expect(text).toContain(FAN_OUT_SUFFIX);
  });

  it('collapses to an empty string in single-vault mode', () => {
    expect(describeMultiVault(registryOf('only'), FAN_OUT_SUFFIX)).toBe('');
  });
});
