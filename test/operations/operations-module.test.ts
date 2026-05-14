import { describe, expect, it } from 'vitest';

import { createOperationsModule } from '../../src/modules/operations/index.js';
import type { ObsidianCLIProviderOptions } from '../../src/modules/operations/obsidian-cli-provider.js';
import type { VaultProvider } from '../../src/lib/obsidian/vault-provider.js';

describe('createOperationsModule', () => {
  it('forwards vaultName and binaryPath to the provider factory', () => {
    const seen: ObsidianCLIProviderOptions[] = [];
    const fakeProvider = {} as VaultProvider;

    createOperationsModule(
      { vaultPath: '/tmp/MyVault', vaultName: 'MyVault', binaryPath: '/usr/bin/obsidian' },
      {
        vaultProviderFactory: (opts) => {
          seen.push(opts);
          return fakeProvider;
        },
      },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ binaryPath: '/usr/bin/obsidian', vaultName: 'MyVault' });
  });
});
