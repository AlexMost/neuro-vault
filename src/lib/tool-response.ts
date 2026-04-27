import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export class ToolHandlerError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message);
    this.name = 'ToolHandlerError';
    this.code = code;
    this.details = options?.details;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

type ToolContentBlock = { type: 'text'; text: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function toToolResponse(value: unknown): CallToolResult {
  const text = value === undefined ? 'ok' : JSON.stringify(value, null, 2);
  const result: CallToolResult = {
    content: [{ type: 'text', text }] satisfies ToolContentBlock[],
  };
  if (isPlainRecord(value)) {
    result.structuredContent = value;
  }
  return result;
}

export function toToolErrorResponse(error: unknown): CallToolResult {
  if (error instanceof ToolHandlerError) {
    return {
      content: [{ type: 'text', text: error.message }],
      structuredContent: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
      isError: true,
    };
  }

  const message = error instanceof Error ? error.message : 'Unknown tool error';
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { message },
    isError: true,
  };
}

export async function invokeTool<T>(handler: () => Promise<T>): Promise<CallToolResult> {
  try {
    const value = await handler();
    return toToolResponse(value);
  } catch (error) {
    return toToolErrorResponse(error);
  }
}
