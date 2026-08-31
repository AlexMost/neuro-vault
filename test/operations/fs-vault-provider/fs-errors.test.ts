import { describe, expect, it, vi } from 'vitest';

import { byPath, makeProvider, makeVault } from './_helpers.js';

describe('FsVaultProvider: one fs-error taxonomy over existing notes', () => {
  it('maps a failing write to WRITE_FAILED on setProperty', async () => {
    const root = await makeVault({ 'n.md': '---\na: 1\n---\nbody\n' });
    const provider = makeProvider(root, {
      writeFile: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
        ),
    });

    await expect(
      provider.setProperty({ identifier: byPath('n.md'), name: 'a', value: 2 }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', details: { path: 'n.md' } });
  });

  it('maps a failing write to WRITE_FAILED on removeProperty', async () => {
    const root = await makeVault({ 'n.md': '---\na: 1\n---\nbody\n' });
    const provider = makeProvider(root, {
      writeFile: vi.fn().mockRejectedValue(new Error('EROFS: read-only file system')),
    });

    await expect(
      provider.removeProperty({ identifier: byPath('n.md'), name: 'a' }),
    ).rejects.toMatchObject({ code: 'WRITE_FAILED', details: { path: 'n.md' } });
  });

  it('maps a non-ENOENT read failure to READ_FAILED', async () => {
    const root = await makeVault({ 'n.md': '---\na: 1\n---\nbody\n' });
    const provider = makeProvider(root, {
      readFile: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        ),
    });

    await expect(
      provider.setProperty({ identifier: byPath('n.md'), name: 'a', value: 2 }),
    ).rejects.toMatchObject({ code: 'READ_FAILED', details: { path: 'n.md' } });
  });

  it('still maps ENOENT to NOT_FOUND', async () => {
    const root = await makeVault({});
    const provider = makeProvider(root);

    await expect(
      provider.setProperty({ identifier: byPath('missing.md'), name: 'a', value: 2 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', details: { path: 'missing.md' } });
  });
});
