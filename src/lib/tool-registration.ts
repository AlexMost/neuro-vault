import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolRegistration {
  name: string;
  spec: {
    title?: string;
    description?: string;
    inputSchema?: ZodRawShapeCompat | AnySchema;
    annotations?: ToolAnnotations;
  };
  handler: (args: unknown) => Promise<CallToolResult>;
}
