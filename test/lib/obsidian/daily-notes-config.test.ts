import { describe, expect, it } from 'vitest';

import { readDailyNotesConfig } from '../../../src/lib/obsidian/daily-notes-config.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';

function fakeReadFile(map: Record<string, string | Error>) {
  return async (absPath: string, _enc: 'utf8'): Promise<string> => {
    const value = map[absPath];
    if (value === undefined) {
      const err = new Error(`ENOENT: ${absPath}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    if (value instanceof Error) throw value;
    return value;
  };
}

describe('readDailyNotesConfig', () => {
  const VAULT = '/v';
  const CONFIG = '/v/.obsidian/daily-notes.json';

  it('returns folder and format on a valid config', async () => {
    const cfg = await readDailyNotesConfig(
      VAULT,
      fakeReadFile({
        [CONFIG]: JSON.stringify({ folder: '01 Daily', format: 'YYYY-MM-DD' }),
      }),
    );
    expect(cfg).toEqual({ folder: '01 Daily', format: 'YYYY-MM-DD' });
  });

  it('defaults format to YYYY-MM-DD when absent', async () => {
    const cfg = await readDailyNotesConfig(
      VAULT,
      fakeReadFile({
        [CONFIG]: JSON.stringify({ folder: '01 Daily' }),
      }),
    );
    expect(cfg.format).toBe('YYYY-MM-DD');
  });

  it('defaults format to YYYY-MM-DD when present but empty', async () => {
    const cfg = await readDailyNotesConfig(
      VAULT,
      fakeReadFile({
        [CONFIG]: JSON.stringify({ folder: '01 Daily', format: '' }),
      }),
    );
    expect(cfg.format).toBe('YYYY-MM-DD');
  });

  it('strips trailing slash on folder', async () => {
    const cfg = await readDailyNotesConfig(
      VAULT,
      fakeReadFile({
        [CONFIG]: JSON.stringify({ folder: '01 Daily/' }),
      }),
    );
    expect(cfg.folder).toBe('01 Daily');
  });

  it('throws DAILY_NOTES_NOT_CONFIGURED when file is missing', async () => {
    await expect(readDailyNotesConfig(VAULT, fakeReadFile({}))).rejects.toMatchObject({
      code: 'DAILY_NOTES_NOT_CONFIGURED',
    });
  });

  it('throws DAILY_NOTES_NOT_CONFIGURED on malformed JSON', async () => {
    await expect(
      readDailyNotesConfig(VAULT, fakeReadFile({ [CONFIG]: '{not json' })),
    ).rejects.toMatchObject({ code: 'DAILY_NOTES_NOT_CONFIGURED' });
  });

  it('throws DAILY_NOTES_NOT_CONFIGURED when folder is missing', async () => {
    await expect(
      readDailyNotesConfig(VAULT, fakeReadFile({ [CONFIG]: JSON.stringify({}) })),
    ).rejects.toMatchObject({ code: 'DAILY_NOTES_NOT_CONFIGURED' });
  });

  it('throws DAILY_NOTES_NOT_CONFIGURED when folder is empty', async () => {
    await expect(
      readDailyNotesConfig(VAULT, fakeReadFile({ [CONFIG]: JSON.stringify({ folder: '' }) })),
    ).rejects.toMatchObject({ code: 'DAILY_NOTES_NOT_CONFIGURED' });
  });

  it('throws DAILY_NOTES_NOT_CONFIGURED when folder is whitespace-only', async () => {
    await expect(
      readDailyNotesConfig(VAULT, fakeReadFile({ [CONFIG]: JSON.stringify({ folder: '   ' }) })),
    ).rejects.toMatchObject({ code: 'DAILY_NOTES_NOT_CONFIGURED' });
  });

  it('error is a ToolHandlerError with a remediation message', async () => {
    try {
      await readDailyNotesConfig(VAULT, fakeReadFile({}));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolHandlerError);
      expect((err as ToolHandlerError).message).toMatch(/daily-notes\.json/);
    }
  });
});
