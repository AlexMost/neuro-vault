import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolRegistration {
  name: string;
  spec: {
    title?: string;
    description?: string;
    inputSchema?: ZodRawShapeCompat | AnySchema;
    outputSchema?: ZodRawShapeCompat | AnySchema;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  };
  handler: (args: unknown) => Promise<CallToolResult>;
}
