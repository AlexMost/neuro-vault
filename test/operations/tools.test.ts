import { describe, expect, it, vi } from 'vitest';

import { buildOperationsTools } from '../../src/modules/operations/tools/index.js';
import { FAN_OUT_SUFFIX } from '../../src/lib/vault-param.js';
import type { VaultProvider } from '../../src/lib/obsidian/vault-provider.js';
import type { VaultReader } from '../../src/lib/obsidian/vault-reader.js';
import type { WikilinkGraphIndex } from '../../src/lib/obsidian/wikilink-graph.js';
import type { IVaultRegistry } from '../../src/lib/vault-registry.js';

const noopProvider = {
  createNote: vi.fn(),
  readDaily: vi.fn(),
  setProperty: vi.fn(),
  removeProperty: vi.fn(),
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

const noopEntry = {
  name: 'test',
  path: '/tmp/vault',
  reader: noopReader,
  provider: noopProvider,
  graph: noopGraph,
  listMatchingPaths: vi.fn(),
};

const noopRegistry = {
  get: vi.fn(),
  require: vi.fn(),
  list: vi.fn(() => [noopEntry]),
  isMulti: vi.fn(() => false),
  names: vi.fn(() => ['test']),
} as unknown as IVaultRegistry;

const noopDeps = {
  registry: noopRegistry,
};

const multiRegistry = {
  get: vi.fn(),
  require: vi.fn(),
  list: vi.fn(() => [noopEntry, { ...noopEntry, name: 'other' }]),
  isMulti: vi.fn(() => true),
  names: vi.fn(() => ['test', 'other']),
} as unknown as IVaultRegistry;

describe('buildOperationsTools', () => {
  it('returns 11 registrations with the expected names', () => {
    const tools = buildOperationsTools(noopDeps);
    expect(tools.map((t) => t.name)).toEqual([
      'read_notes',
      'query_notes',
      'create_note',
      'edit_note',
      'read_daily',
      'set_property',
      'remove_property',
      'list_tags',
      'list_properties',
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

  it('list_properties description promises the full inventory vs the truncated overview', () => {
    const tools = buildOperationsTools(noopDeps);
    const listProperties = tools.find((t) => t.name === 'list_properties')!;
    expect(listProperties.spec.description).toMatch(/ALL frontmatter properties/);
    expect(listProperties.spec.description).toMatch(/complete inventory/i);
    expect(listProperties.spec.description).toMatch(/get_vault_overview/);
    expect(listProperties.spec.description).toMatch(/count/i);
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

  // The next three guard content that used to live only in the server
  // `instructions` string, which the client truncates and never gives to
  // sub-agents. Tool descriptions are delivered in full, so this is where the
  // guidance has to be asserted.
  it('read_daily description names the write-back route into today’s note', () => {
    const tools = buildOperationsTools(noopDeps);
    const readDaily = tools.find((t) => t.name === 'read_daily')!;
    expect(readDaily.spec.description).toMatch(/edit_note/);
    expect(readDaily.spec.description).toMatch(/create_note/);
  });

  it('edit_note description states disk-direct writes and the last-writer-wins caveat', () => {
    const tools = buildOperationsTools(noopDeps);
    const editNote = tools.find((t) => t.name === 'edit_note')!;
    expect(editNote.spec.description).toMatch(/directly on disk/i);
    expect(editNote.spec.description).toMatch(/Obsidian does not need to be installed or running/i);
    expect(editNote.spec.description).toMatch(/last writer wins/i);
  });

  it('states the VAULT_REQUIRED contract on every tool that cannot fan out', () => {
    const tools = buildOperationsTools({ registry: multiRegistry });
    const explicitVaultTools = [
      'read_notes',
      'create_note',
      'edit_note',
      'read_daily',
      'set_property',
      'remove_property',
      'get_note_links',
    ];
    for (const name of explicitVaultTools) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.spec.description, name).toMatch(/VAULT_REQUIRED/);
    }
  });

  it('query_notes description steers an in-vault agent away from scanning files by hand', () => {
    const tools = buildOperationsTools(noopDeps);
    const queryNotes = tools.find((t) => t.name === 'query_notes')!;
    expect(queryNotes.spec.description).toMatch(/filesystem access/i);
    expect(queryNotes.spec.description).toMatch(/instead of grepping or scanning files/i);
    expect(queryNotes.spec.description).toMatch(/search_notes/);
  });

  it('enumerates the registered vault names in every multi-vault description', () => {
    const tools = buildOperationsTools({ registry: multiRegistry });
    for (const tool of tools) {
      expect(tool.spec.description, tool.name).toMatch(/Registered vaults: "test", "other"\./);
    }
  });

  it('leaks no vault-name enumeration in single-vault mode', () => {
    const tools = buildOperationsTools(noopDeps);
    for (const tool of tools) {
      expect(tool.spec.description, tool.name).not.toMatch(/Registered vaults:/);
    }
  });

  it('names failed_vaults on every fan-out tool description', () => {
    const tools = buildOperationsTools({ registry: multiRegistry });
    for (const name of ['query_notes', 'list_tags', 'list_properties', 'get_vault_overview']) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.spec.description, name).toMatch(/failed_vaults/);
    }
  });

  it('list_properties carries the shared fan-out prose and no skipped_vaults', () => {
    const tools = buildOperationsTools({ registry: multiRegistry });
    const listProperties = tools.find((t) => t.name === 'list_properties')!;
    expect(listProperties.spec.description).toContain(FAN_OUT_SUFFIX);
    expect(listProperties.spec.description).not.toContain('skipped_vaults');
  });
});
