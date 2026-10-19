import type { ZodTypeAny } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import { wrapSchemaWithCoercion } from './input-coercion.js';
import type { ToolRegistration } from './tool-registration.js';
import { invokeTool, ToolHandlerError } from './tool-response.js';
import { formatZodError } from './zod-issues.js';

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
  const coercingSchema = wrapSchemaWithCoercion(tool.inputSchema);
  return {
    name: tool.name,
    spec: {
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: coercingSchema,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    },
    handler: async (args) =>
      invokeTool(async () => {
        const result = coercingSchema.safeParse(args);
        if (!result.success) {
          const { message, issues } = formatZodError(result.error);
          throw new ToolHandlerError('INVALID_PARAMS', message, { details: { issues } });
        }
        return tool.handler(result.data as I);
      }),
  };
}
