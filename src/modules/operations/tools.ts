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
import { buildRemovePropertyTool } from './tools/remove-property.js';
import { buildListPropertiesTool } from './tools/list-properties.js';

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
    registerTool(buildRemovePropertyTool(deps)),
    registerTool(buildListPropertiesTool(deps)),
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
