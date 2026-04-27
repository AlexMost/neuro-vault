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
import { buildSetPropertyTool } from './tools/set-property.js';
import { buildReadPropertyTool } from './tools/read-property.js';

const noteIdentifierShape = {
  name: z.string().optional(),
  path: z.string().optional(),
};

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
    registerTool(buildSetPropertyTool(deps)),
    registerTool(buildReadPropertyTool(deps)),
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
