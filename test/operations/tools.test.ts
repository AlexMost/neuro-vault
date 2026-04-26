import { describe, expect, it, vi } from 'vitest';

import { buildOperationsTools } from '../../src/modules/operations/tools.js';

const noopHandlers = {
  readNote: vi.fn(),
  createNote: vi.fn(),
  editNote: vi.fn(),
  readDaily: vi.fn(),
  appendDaily: vi.fn(),
  setProperty: vi.fn(),
  readProperty: vi.fn(),
  removeProperty: vi.fn(),
  listProperties: vi.fn(),
  listTags: vi.fn(),
  getTag: vi.fn(),
};

describe('buildOperationsTools', () => {
  it('returns 11 registrations with the expected names', () => {
    const tools = buildOperationsTools(noopHandlers);
    expect(tools.map((t) => t.name)).toEqual([
      'read_note',
      'create_note',
      'edit_note',
      'read_daily',
      'append_daily',
      'set_property',
      'read_property',
      'remove_property',
      'list_properties',
      'list_tags',
      'get_tag',
    ]);
  });

  it('create_note description tells the LLM to ask before overwriting', () => {
    const tools = buildOperationsTools(noopHandlers);
    const createNote = tools.find((t) => t.name === 'create_note')!;
    expect(createNote.spec.description).toMatch(/ask the user/i);
    expect(createNote.spec.description).toMatch(/overwrite/i);
  });

  it('list_properties description mentions sorting by occurrence count', () => {
    const tools = buildOperationsTools(noopHandlers);
    const listProperties = tools.find((t) => t.name === 'list_properties')!;
    expect(listProperties.spec.description).toMatch(/sorted by occurrence count desc/i);
  });

  it('remove_property description states idempotency', () => {
    const tools = buildOperationsTools(noopHandlers);
    const removeProperty = tools.find((t) => t.name === 'remove_property')!;
    expect(removeProperty.spec.description).toMatch(/idempotent/i);
  });
});
