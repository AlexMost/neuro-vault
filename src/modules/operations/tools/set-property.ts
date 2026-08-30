import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { buildSingleVaultTool } from '../../../lib/single-vault-tool.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { inferTypeAndValidate, invalidArgument, resolveIdentifier } from '../tool-helpers.js';

interface Input {
  vault?: string;
  name?: string;
  path?: string;
  key: string;
  value: string | number | boolean | string[] | number[];
  type?: 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime';
}

export interface SetPropertyDeps {
  registry: IVaultRegistry;
}

export function buildSetPropertyTool(
  deps: SetPropertyDeps,
): ITool<Input, { vault: string; ok: true }> {
  const { registry } = deps;
  return buildSingleVaultTool<Input, { vault: string; ok: true }>(registry, {
    name: 'set_property',
    title: 'Set Property',
    description:
      'Set a frontmatter property on a note. Provide either `name` (wikilink-style) or `path` (vault-relative). `key` is the frontmatter property name (e.g. `status`, `due`). `value` may be string/number/boolean/array — `type` is inferred from the JS type unless given. For `date`/`datetime` you MUST pass `type` explicitly AND use ISO format (`YYYY-MM-DD` for date, `YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]` for datetime) — non-ISO values are rejected up front. List items must not contain commas. Existing properties are overwritten. Returns `{ vault, ok: true }`.',
    inputShape: {
      name: z.string().optional(),
      path: z.string().optional(),
      key: z.string(),
      value: z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.string()),
        z.array(z.number()),
      ]),
      type: z.enum(['text', 'list', 'number', 'checkbox', 'date', 'datetime']).optional(),
    },
    runForEntry: async (entry, input) => {
      const identifier = resolveIdentifier(input.name, input.path);
      if (!input.key || input.key.trim() === '') {
        throw invalidArgument('key must not be empty', 'key');
      }
      const { value, type } = inferTypeAndValidate(input.value, input.type);
      await entry.provider.setProperty({ identifier, name: input.key.trim(), value, type });
      return { vault: entry.name, ok: true as const };
    },
  });
}
