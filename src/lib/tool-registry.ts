import type { ZodTypeAny } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import type { ToolRegistration } from './tool-registration.js';
import { invokeTool } from './tool-response.js';

export interface ITool<I, O> {
  name: string;
  title?: string;
  description: string;
  inputSchema: ZodTypeAny;
  outputSchema?: ZodTypeAny;
  annotations?: ToolAnnotations;
  handler: (input: I) => Promise<O>;
}

export function registerTool<I, O>(tool: ITool<I, O>): ToolRegistration {
  return {
    name: tool.name,
    spec: {
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    },
    handler: async (args) =>
      invokeTool(async () => {
        const parsed = tool.inputSchema.parse(args) as I;
        return tool.handler(parsed);
      }),
  };
}
