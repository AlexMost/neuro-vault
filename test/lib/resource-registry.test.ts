import { describe, expect, it } from 'vitest';

import { registerResource } from '../../src/lib/resource-registry.js';

describe('registerResource', () => {
  it('returns a registration with name, uri, metadata, and handler', async () => {
    const reg = registerResource({
      name: 'demo',
      uri: 'demo://thing',
      title: 'Demo Thing',
      description: 'A demo resource.',
      mimeType: 'application/json',
      handler: async () => ({ payload: 42 }),
    });

    expect(reg.name).toBe('demo');
    expect(reg.uri).toBe('demo://thing');
    expect(reg.metadata.title).toBe('Demo Thing');
    expect(reg.metadata.description).toBe('A demo resource.');
    expect(reg.metadata.mimeType).toBe('application/json');

    const result = await reg.handler(new URL('demo://thing'));
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toEqual({
      uri: 'demo://thing',
      mimeType: 'application/json',
      text: JSON.stringify({ payload: 42 }),
    });
  });
});
