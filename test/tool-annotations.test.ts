import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODEL_KEY, resolveModelProfile } from '../src/lib/model-profiles.js';
import { TOOL_NAMES, type ToolName } from '../src/lib/tool-names.js';
import type { ToolRegistration } from '../src/lib/tool-registration.js';
import { buildOperationsTools } from '../src/modules/operations/tools/index.js';
import { buildLexicalOnlyTools, buildSemanticTools } from '../src/modules/semantic/tools/index.js';
import type { QueryEmbedder } from '../src/modules/semantic/types.js';
import { TEST_SIMILARITY } from './_identity.js';
import { makeTestRegistry } from './operations/tools/_test-registry.js';

// A read: never mutates the vault, safe to repeat, and only ever touches the
// local vault (closed world). `destructiveHint` is stated outright rather than
// left to its spec default of `true`, so a client that reads it without first
// checking `readOnlyHint` still sees the truth.
const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// A write that can replace or delete what is already there: `create_note`
// under `overwrite: true`, `edit_note` without `replace` (whole-body
// overwrite), `set_property` on an existing key, `remove_property` always.
// `idempotentHint` is left unset (spec default `false`): a repeated call is
// not safe in general.
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

/**
 * The advertised annotations, one row per tool name in `TOOL_NAMES`. Typed as
 * a `Record<ToolName, …>` so adding a name to `TOOL_NAMES` without a row here
 * fails `npm run typecheck`, and the coverage case below fails if a builder
 * registers a tool `TOOL_NAMES` does not list.
 */
const EXPECTED: Record<ToolName, ToolAnnotations> = {
  read_notes: READ,
  query_notes: READ,
  create_note: WRITE,
  edit_note: WRITE,
  read_daily: READ,
  set_property: WRITE,
  remove_property: WRITE,
  list_tags: READ,
  list_properties: READ,
  get_note_links: READ,
  get_vault_overview: READ,
  search_notes: READ,
  get_similar_notes: READ,
  find_duplicates: READ,
};

const embeddingProvider: QueryEmbedder = { initialize: vi.fn(), embedQuery: vi.fn() };

function allRegistrations(): ToolRegistration[] {
  const registry = makeTestRegistry([{ name: 'v', path: '/vaults/v' }]);
  return [
    ...buildOperationsTools({ registry }),
    ...buildSemanticTools({
      registry,
      embeddingProvider,
      modelKey: 'bge-micro-v2',
      similarity: TEST_SIMILARITY,
    }),
  ];
}

describe('tool annotations (advertised on reg.spec)', () => {
  it('registers exactly the tools TOOL_NAMES lists, so every row below is exercised', () => {
    expect(
      allRegistrations()
        .map((r) => r.name)
        .sort(),
    ).toEqual([...TOOL_NAMES].sort());
  });

  it.each(TOOL_NAMES)('%s advertises its read/write annotations', (name) => {
    const reg = allRegistrations().find((r) => r.name === name);
    expect(reg, `${name} is not registered`).toBeDefined();
    expect(reg!.spec.annotations).toEqual(EXPECTED[name]);
  });

  it('the --no-semantic search_notes registration carries the same read-only annotations', () => {
    const registry = makeTestRegistry([{ name: 'v', path: '/vaults/v' }]);
    const [searchNotes] = buildLexicalOnlyTools(registry, resolveModelProfile(DEFAULT_MODEL_KEY));
    expect(searchNotes.name).toBe('search_notes');
    expect(searchNotes.spec.annotations).toEqual(EXPECTED.search_notes);
  });
});
