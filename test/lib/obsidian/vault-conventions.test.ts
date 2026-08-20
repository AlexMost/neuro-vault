import { describe, expect, it, vi } from 'vitest';

import {
  CONVENTIONS_CHAR_CAP,
  CONVENTIONS_PATH,
  capConventions,
  readVaultConventions,
} from '../../../src/lib/obsidian/vault-conventions.js';

describe('readVaultConventions', () => {
  it('reads the conventions file relative to the vault root', async () => {
    const readFile = vi.fn().mockResolvedValue('\n\n# Conventions\n- No writes to Resources/\n\n');
    const result = await readVaultConventions('/vaults/obsidian', readFile);
    expect(result).toBe('# Conventions\n- No writes to Resources/');
    expect(readFile).toHaveBeenCalledWith('/vaults/obsidian/' + CONVENTIONS_PATH, 'utf8');
  });

  it('returns null when the file is missing or unreadable', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    expect(await readVaultConventions('/v', readFile)).toBeNull();
  });

  it('returns null for an empty or whitespace-only file', async () => {
    expect(await readVaultConventions('/v', vi.fn().mockResolvedValue(''))).toBeNull();
    expect(await readVaultConventions('/v', vi.fn().mockResolvedValue('  \n\t\n '))).toBeNull();
  });
});

describe('capConventions', () => {
  it('passes content shorter than the cap through untouched', () => {
    expect(capConventions('short')).toEqual({ content: 'short', truncated: false });
  });

  it('passes content exactly at the cap through untouched', () => {
    const exact = 'x'.repeat(CONVENTIONS_CHAR_CAP);
    expect(capConventions(exact)).toEqual({ content: exact, truncated: false });
  });

  it('trims content over the cap and flags it', () => {
    const over = 'x'.repeat(CONVENTIONS_CHAR_CAP + 1);
    const result = capConventions(over);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(CONVENTIONS_CHAR_CAP + 1);
    expect(result.content.endsWith('…')).toBe(true);
  });
});
