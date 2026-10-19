import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { ServiceRegistry } from '../../src/daemon/protocol.js';
import { createLexicalService } from '../../src/daemon/services/lexical.js';
import type {
  ILexicalResult,
  ILexicalSearchOptions,
} from '../../src/lib/obsidian/lexical/reader.js';
import { VaultEntryError } from '../../src/lib/vault-entry/index.js';
import { testCtx } from './_ctx.js';

const VAULT = '/real/vault';

const RESULT: ILexicalResult = {
  notes: [
    {
      path: 'a.md',
      matches: [{ matched_in: 'body', snippet: 'snip', lines: [1, 2] }],
      matchedQueries: ['q'],
    },
  ],
  truncated: true,
  perQueryCounts: { q: 1 },
  perQueryTokenCounts: { q: { tok: 3 } },
  totalNotes: 7,
};

function setup(search?: (opts: ILexicalSearchOptions) => Promise<ILexicalResult>) {
  const lexicalSearch = vi.fn(search ?? (async () => RESULT));
  const entries = {
    lexical: vi.fn((_id: number, vault: string) => {
      if (vault !== VAULT) {
        throw new VaultEntryError('NOT_ATTACHED', `vault "${vault}" is not attached`);
      }
      return { lexicalSearch };
    }),
  };
  const registry = new ServiceRegistry();
  registry.register('lexical', createLexicalService(entries));
  let next = 1;
  const call = (params?: unknown, connection = 1) => {
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: next++,
      method: 'lexical.search',
      params: params as never,
    };
    return registry.dispatch(request, testCtx(connection));
  };
  return { entries, lexicalSearch, call };
}

function errorOf(response: JSONRPCMessage) {
  if (!isJSONRPCErrorResponse(response)) throw new Error('expected an error response');
  return {
    code: (response.error.data as { code: string }).code,
    message: response.error.message,
  };
}

const valid = { vault: VAULT, queries: ['q'], note_cap: 10, per_note_cap: 3 };

describe('lexical.search', () => {
  it('maps the result to snake_case and passes matches through', async () => {
    const { call, lexicalSearch, entries } = setup();
    const response = await call({ ...valid, allowed: ['a.md', 'b.md'] });

    if (!isJSONRPCResultResponse(response)) throw new Error('expected a result response');
    expect(response.result).toEqual({
      notes: [
        {
          path: 'a.md',
          matches: [{ matched_in: 'body', snippet: 'snip', lines: [1, 2] }],
          matched_queries: ['q'],
        },
      ],
      truncated: true,
      per_query_counts: { q: 1 },
      per_query_token_counts: { q: { tok: 3 } },
      total_notes: 7,
    });
    expect(entries.lexical).toHaveBeenCalledWith(1, VAULT);
    expect(lexicalSearch).toHaveBeenCalledWith({
      queries: ['q'],
      allowed: new Set(['a.md', 'b.md']),
      noteCap: 10,
      perNoteCap: 3,
    });
  });

  it('passes no allowed key when the param is absent, and a Set for an empty array', async () => {
    const { call, lexicalSearch } = setup();
    await call(valid);
    expect(lexicalSearch.mock.calls[0]?.[0]).not.toHaveProperty('allowed');
    await call({ ...valid, allowed: [] });
    expect(lexicalSearch.mock.calls[1]?.[0].allowed).toEqual(new Set());
  });

  it('lets blank queries through', async () => {
    const { call, lexicalSearch } = setup();
    await call({ ...valid, queries: ['', 'q'] });
    expect(lexicalSearch.mock.calls[0]?.[0].queries).toEqual(['', 'q']);
  });

  it('answers NOT_ATTACHED for a vault the connection did not attach', async () => {
    const { call, lexicalSearch } = setup();
    expect(errorOf(await call({ ...valid, vault: '/other' }))).toMatchObject({
      code: 'NOT_ATTACHED',
    });
    expect(lexicalSearch).not.toHaveBeenCalled();
  });

  it('answers LEXICAL_FAILED carrying the thrown message', async () => {
    const { call } = setup(async () => {
      throw new Error('scan exploded');
    });
    expect(errorOf(await call(valid))).toEqual({
      code: 'LEXICAL_FAILED',
      message: 'scan exploded',
    });
  });
});
