import type { ZodError, ZodTypeAny } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import { wrapSchemaWithCoercion } from './input-coercion.js';
import type { ToolRegistration } from './tool-registration.js';
import { invokeTool, ToolHandlerError } from './tool-response.js';

export interface ITool<I, O> {
  name: string;
  title?: string;
  description: string;
  inputSchema: ZodTypeAny;
  outputSchema?: ZodTypeAny;
  annotations?: ToolAnnotations;
  handler: (input: I) => Promise<O>;
}

interface FormattedIssue {
  path: string;
  message: string;
  expected?: string;
}

function formatZodError(error: ZodError): {
  message: string;
  issues: FormattedIssue[];
} {
  const issues: FormattedIssue[] = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    const expected = (issue as unknown as { expected?: unknown }).expected;
    const formatted: FormattedIssue = { path, message: issue.message };
    if (typeof expected === 'string') formatted.expected = expected;
    return formatted;
  });
  const message = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  return { message, issues };
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
