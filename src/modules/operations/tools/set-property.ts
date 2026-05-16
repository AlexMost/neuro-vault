import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { inferTypeAndValidate, invalidArgument, resolveIdentifier } from '../tool-helpers.js';
import type { SetPropertyToolInput } from '../types.js';
import { describeMultiVault, vaultParamShape } from '../../../lib/vault-param.js';

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
  const inputSchema = z.object({
    ...vaultParamShape(registry),
    name: z.string().optional(),
    path: z.string().optional(),
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number())]),
    type: z.enum(['text', 'list', 'number', 'checkbox', 'date', 'datetime']).optional(),
  });
  return {
    name: 'set_property',
    title: 'Set Property',
    description:
      'Set a frontmatter property on a note. Provide either `name` (wikilink-style) or `path` (vault-relative). `key` is the frontmatter property name (e.g. `status`, `due`). `value` may be string/number/boolean/array — `type` is inferred from the JS type unless given. For `date`/`datetime` you MUST pass `type` explicitly AND use ISO format (`YYYY-MM-DD` for date, `YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]` for datetime) — non-ISO values are silently dropped by obsidian-cli, so this tool rejects them up front. List items must not contain commas (obsidian-cli limitation). Existing properties are overwritten. Returns `{ vault, ok: true }`.' +
      describeMultiVault(
        registry,
        'Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
      ),
    inputSchema,
    handler: async (input: SetPropertyToolInput & { vault?: string }) => {
      const entry = resolveVault(input, registry, { tool: 'set_property' });
      const identifier = resolveIdentifier(input.name, input.path);
      if (!input.key || input.key.trim() === '') {
        throw invalidArgument('key must not be empty', 'key');
      }
      const { value, type } = inferTypeAndValidate(input.value, input.type);
      await entry.provider!.setProperty({ identifier, name: input.key.trim(), value, type });
      return { vault: entry.name, ok: true as const };
    },
  };
}
