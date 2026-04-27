import { describe, expect, it, vi } from 'vitest';

import { buildOperationsTools } from '../../src/modules/operations/tools/index.js';
import type { VaultProvider } from '../../src/modules/operations/vault-provider.js';
import type { VaultReader } from '../../src/modules/operations/vault-reader.js';

const noopProvider = {
  createNote: vi.fn(),
  editNote: vi.fn(),
  readDaily: vi.fn(),
  appendDaily: vi.fn(),
  setProperty: vi.fn(),
  readProperty: vi.fn(),
  removeProperty: vi.fn(),
  listProperties: vi.fn(),
  listTags: vi.fn(),
} as unknown as VaultProvider;

const noopReader = {
  readNotes: vi.fn(),
  scan: vi.fn(),
} as unknown as VaultReader;

const noopDeps = { provider: noopProvider, reader: noopReader };

describe('buildOperationsTools', () => {
  it('returns 11 registrations with the expected names', () => {
    const tools = buildOperationsTools(noopDeps);
    expect(tools.map((t) => t.name)).toEqual([
      'read_notes',
      'query_notes',
      'create_note',
      'edit_note',
      'read_daily',
      'append_daily',
      'set_property',
      'read_property',
      'remove_property',
      'list_properties',
      'list_tags',
    ]);
  });

  it('query_notes description names the supported operators and result fields', () => {
    const tools = buildOperationsTools(noopDeps);
    const queryNotes = tools.find((t) => t.name === 'query_notes')!;
    expect(queryNotes.spec.description).toMatch(/MongoDB/);
    expect(queryNotes.spec.description).toMatch(/\$and/);
    expect(queryNotes.spec.description).toMatch(/\$exists/);
    expect(queryNotes.spec.description).toMatch(/truncated/);
    expect(queryNotes.spec.description).toMatch(/include_content/);
  });

  it('create_note description tells the LLM to ask before overwriting', () => {
    const tools = buildOperationsTools(noopDeps);
    const createNote = tools.find((t) => t.name === 'create_note')!;
    expect(createNote.spec.description).toMatch(/ask the user/i);
    expect(createNote.spec.description).toMatch(/overwrite/i);
  });

  it('list_properties description mentions sorting by occurrence count', () => {
    const tools = buildOperationsTools(noopDeps);
    const listProperties = tools.find((t) => t.name === 'list_properties')!;
    expect(listProperties.spec.description).toMatch(/sorted by occurrence count desc/i);
  });

  it('remove_property description states idempotency', () => {
    const tools = buildOperationsTools(noopDeps);
    const removeProperty = tools.find((t) => t.name === 'remove_property')!;
    expect(removeProperty.spec.description).toMatch(/idempotent/i);
  });

  it('read_notes description states 1–50, dedupe, per-item errors, and offline reads', () => {
    const tools = buildOperationsTools(noopDeps);
    const readNotes = tools.find((t) => t.name === 'read_notes')!;
    expect(readNotes.spec.description).toMatch(/1[–-]50/);
    expect(readNotes.spec.description).toMatch(/de-duplicated/i);
    expect(readNotes.spec.description).toMatch(/per-item errors/i);
    expect(readNotes.spec.description).toMatch(/do not require Obsidian/i);
  });
});
