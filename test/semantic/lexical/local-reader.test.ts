import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LexicalSearchError } from '../../../src/lib/obsidian/lexical/reader.js';
import { createVaultEntry, VaultEntries } from '../../../src/lib/vault-entry/index.js';
import { createLocalAttachment } from '../../../src/modules/semantic/backend/attachment.js';
import { createLocalLexicalReader } from '../../../src/modules/semantic/lexical/index.js';
import { writeFixtureVault } from '../../lib/obsidian/lexical/_fixture-vault.js';

const CONNECTION_ID = 1;
const SEARCH = { queries: ['розумний пошук'], noteCap: 10, perNoteCap: 3 };

let root: string;
let entries: VaultEntries;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-lexical-'));
  await writeFixtureVault(root);
  entries = new VaultEntries({
    embedderFor: () => async (texts) => texts.map(() => []),
    idleTimeoutMs: 0,
    createEntry: (opts) => createVaultEntry({ ...opts, debounceMs: 100 }),
    warn: () => {},
  });
});

afterEach(async () => {
  await entries.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

function readerFor(vaultRoot: string) {
  const attachment = createLocalAttachment({
    entries,
    connectionId: CONNECTION_ID,
    vaultRoot,
    profiles: [],
  });
  return {
    attachment,
    reader: createLocalLexicalReader({ entries, connectionId: CONNECTION_ID, attachment }),
  };
}

describe('createLocalLexicalReader', () => {
  it("search equals the entry's lexicalSearch", async () => {
    const { reader, attachment } = readerFor(root);

    const actual = await reader.search(SEARCH);

    const expected = await entries
      .lexical(CONNECTION_ID, await attachment.key())
      .lexicalSearch(SEARCH);
    expect(actual).toEqual(expected);
    expect(actual.notes.length).toBeGreaterThan(0);
  });

  it('warm attaches and never rejects', async () => {
    const { reader, attachment } = readerFor(root);
    await expect(reader.warm()).resolves.toBeUndefined();
    expect(attachment.attached).toBe(true);

    const missing = readerFor(path.join(root, 'does-not-exist'));
    await expect(missing.reader.warm()).resolves.toBeUndefined();
  });

  it('a vault that cannot be attached is a LexicalSearchError', async () => {
    const { reader } = readerFor(path.join(root, 'does-not-exist'));

    const error = await reader.search(SEARCH).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LexicalSearchError);
    expect((error as LexicalSearchError).cause).toBeInstanceOf(Error);
  });

  it('NOT_ATTACHED forgets the attach, and the next search attaches again', async () => {
    const { reader, attachment } = readerFor(root);
    await reader.search(SEARCH);

    entries.detach(CONNECTION_ID);
    const error = await reader.search(SEARCH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LexicalSearchError);
    expect(attachment.attached).toBe(false);

    await expect(reader.search(SEARCH)).resolves.toMatchObject({ truncated: false });
  });
});
