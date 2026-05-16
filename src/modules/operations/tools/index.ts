import { registerTool } from '../../../lib/tool-registry.js';
import type { ToolRegistration } from '../../../lib/tool-registration.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { buildCreateNoteTool } from './create-note.js';
import { buildEditNoteTool } from './edit-note.js';
import { buildGetNoteLinksTool } from './get-note-links.js';
import { buildGetVaultOverviewTool } from './get-vault-overview.js';
import { buildListPropertiesTool } from './list-properties.js';
import { buildListTagsTool } from './list-tags.js';
import { buildQueryNotesTool } from './query-notes.js';
import { buildReadDailyTool } from './read-daily.js';
import { buildReadNotesTool } from './read-notes.js';
import { buildReadPropertyTool } from './read-property.js';
import { buildRemovePropertyTool } from './remove-property.js';
import { buildSetPropertyTool } from './set-property.js';

export interface IOperationsToolDeps {
  registry: IVaultRegistry;
}

export function buildOperationsTools(deps: IOperationsToolDeps): ToolRegistration[] {
  return [
    registerTool(buildReadNotesTool(deps)),
    registerTool(buildQueryNotesTool(deps)),
    registerTool(buildCreateNoteTool(deps)),
    registerTool(buildEditNoteTool(deps)),
    registerTool(buildReadDailyTool(deps)),
    registerTool(buildSetPropertyTool(deps)),
    registerTool(buildReadPropertyTool(deps)),
    registerTool(buildRemovePropertyTool(deps)),
    registerTool(buildListPropertiesTool(deps)),
    registerTool(buildListTagsTool(deps)),
    registerTool(buildGetNoteLinksTool(deps)),
    registerTool(buildGetVaultOverviewTool(deps)),
  ];
}
