import { buildOperationsTools, type IOperationsToolDeps } from './tools/index.js';
import { buildOperationsResources } from './resources/index.js';
import type { IVaultRegistry } from '../../lib/vault-registry.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import type { ResourceRegistration } from '../../lib/resource-registration.js';

// empty body — reserved for future module-level options
export interface IOperationsModuleConfig {}

export interface IOperationsModule {
  tools: ToolRegistration[];
  resources: ResourceRegistration[];
}

export function createOperationsModule(
  registry: IVaultRegistry,
  _config: IOperationsModuleConfig = {},
): IOperationsModule {
  const toolDeps: IOperationsToolDeps = { registry };
  return {
    tools: buildOperationsTools(toolDeps),
    resources: buildOperationsResources({ registry }),
  };
}
