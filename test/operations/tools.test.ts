import { describe, expect, it, vi } from 'vitest';

import { buildOperationsTools } from '../../src/modules/operations/tools/index.js';
import type { VaultProvider } from '../../src/lib/obsidian/vault-provider.js';
import type { VaultReader } from '../../src/lib/obsidian/vault-reader.js';
import type { VaultWriter } from '../../src/lib/obsidian/vault-writer.js';
import type { WikilinkGraphIndex } from '../../src/lib/obsidian/wikilink-graph.js';
import type { VaultRegistry } from '../../src/lib/vault-registry.js';

const noopProvider = {
  createNote: vi.fn(),
  readDaily: vi.fn(),
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

const noopGraph = {
  ensureFresh: vi.fn().mockResolvedValue(undefined),
  getNoteLinks: vi.fn(() => ({ incoming: [], outgoing: [] })),
  getBacklinkCount: vi.fn(() => 0),
} as unknown as WikilinkGraphIndex;

const noopWriter = {
  replaceInNote: vi.fn(),
  replaceFullBody: vi.fn(),
} as unknown as VaultWriter;

const noopRegistry = {
  get: vi.fn(),
  require: vi.fn(),
  list: vi.fn(() => []),
  isMulti: vi.fn(() => false),
  names: vi.fn(() => []),
  semanticAvailableEntries: vi.fn(() => []),
} as unknown as VaultRegistry;

const noopDeps = {
  registry: noopRegistry,
  provider: noopProvider,
  reader: noopReader,
  writer: noopWriter,
  graph: noopGraph,
};

describe('buildOperationsTools', () => {
  it('returns 12 registrations with the expected names', () => {
    const tools = buildOperationsTools(noopDeps);
    expect(tools.map((t) => t.name)).toEqual([
      'read_notes',
      'query_notes',
      'create_note',
      'edit_note',
      'read_daily',
      'set_property',
      'read_property',
      'remove_property',
      'list_properties',
      'list_tags',
      'get_note_links',
      'get_vault_overview',
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

  it('read_daily description mentions notes_today, projection, and the 200 cap', () => {
    const tools = buildOperationsTools(noopDeps);
    const readDaily = tools.find((t) => t.name === 'read_daily')!;
    expect(readDaily.spec.description).toMatch(/notes_today/);
    expect(readDaily.spec.description).toMatch(/created today/i);
    expect(readDaily.spec.description).toMatch(/excluding daily notes/i);
    expect(readDaily.spec.description).toMatch(/200/);
  });
});
