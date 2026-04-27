import { z } from 'zod';

import { invokeTool } from '../../lib/tool-response.js';
import { registerTool } from '../../lib/tool-registry.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import type { OperationsToolHandlers } from './types.js';
import type { VaultProvider } from './vault-provider.js';
import type { VaultReader } from './vault-reader.js';
import { buildReadNotesTool } from './tools/read-notes.js';
import { buildQueryNotesTool } from './tools/query-notes.js';
import { buildCreateNoteTool } from './tools/create-note.js';
import { buildEditNoteTool } from './tools/edit-note.js';
import { buildReadDailyTool } from './tools/read-daily.js';
import { buildAppendDailyTool } from './tools/append-daily.js';

const noteIdentifierShape = {
  name: z.string().optional(),
  path: z.string().optional(),
};

const setPropertySchema = z.object({
  ...noteIdentifierShape,
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number())]),
  type: z.enum(['text', 'list', 'number', 'checkbox', 'date', 'datetime']).optional(),
});

const readPropertySchema = z.object({
  ...noteIdentifierShape,
  key: z.string(),
});

const removePropertySchema = z.object({
  ...noteIdentifierShape,
  key: z.string(),
});

const listPropertiesSchema = z.object({});
const listTagsSchema = z.object({});

export function buildOperationsTools(
  handlers: OperationsToolHandlers,
  deps: { provider: VaultProvider; reader: VaultReader },
): ToolRegistration[] {
  return [
    registerTool(buildReadNotesTool(deps)),
    registerTool(buildQueryNotesTool(deps)),
    registerTool(buildCreateNoteTool(deps)),
    registerTool(buildEditNoteTool(deps)),
    registerTool(buildReadDailyTool(deps)),
    registerTool(buildAppendDailyTool(deps)),
    {
      name: 'set_property',
      spec: {
        title: 'Set Property',
        description:
          'Set a frontmatter property on a note. Provide either `name` (wikilink-style) or `path` (vault-relative). `key` is the frontmatter property name (e.g. `status`, `due`). `value` may be string/number/boolean/array — `type` is inferred from the JS type unless given. For `date`/`datetime` you MUST pass `type` explicitly AND use ISO format (`YYYY-MM-DD` for date, `YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]` for datetime) — non-ISO values are silently dropped by obsidian-cli, so this tool rejects them up front. List items must not contain commas (obsidian-cli limitation). Existing properties are overwritten.',
        inputSchema: setPropertySchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.setProperty(setPropertySchema.parse(args))),
    },
    {
      name: 'read_property',
      spec: {
        title: 'Read Property',
        description:
          'Read a frontmatter property value from a note. Provide `name` or `path`, plus `key`. Returns `{ value }`. Use `read_notes` if you need the full frontmatter or accurate type information.',
        inputSchema: readPropertySchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.readProperty(readPropertySchema.parse(args))),
    },
    {
      name: 'remove_property',
      spec: {
        title: 'Remove Property',
        description:
          'Remove a frontmatter property from a note. Provide `name` or `path`, plus `key`. Idempotent — succeeds whether or not the property existed.',
        inputSchema: removePropertySchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.removeProperty(removePropertySchema.parse(args))),
    },
    {
      name: 'list_properties',
      spec: {
        title: 'List Properties',
        description:
          "List all frontmatter properties used across the vault, sorted by occurrence count desc. Returns `[{name, count}]`. Useful for understanding the vault's metadata ontology.",
        inputSchema: listPropertiesSchema,
      },
      handler: async () => invokeTool(() => handlers.listProperties({})),
    },
    {
      name: 'list_tags',
      spec: {
        title: 'List Tags',
        description:
          'List all tags used across the vault, sorted by occurrence count desc. Returns `[{name, count}]`.',
        inputSchema: listTagsSchema,
      },
      handler: async () => invokeTool(() => handlers.listTags({})),
    },
  ];
}
