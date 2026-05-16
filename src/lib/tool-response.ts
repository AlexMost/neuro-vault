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

/**
 * Codes that signal "the whole tool call should fail" rather than "one vault
 * failed and the rest are fine". These errors are not specific to any one
 * vault — they apply uniformly to every vault the call would touch. Examples:
 * caller passed a malformed filter, asked for a vault that does not exist, or
 * omitted a required `vault:` in multi-vault mode.
 *
 * Used by the multi-vault fan-out helpers ({@link runFanOut} /
 * {@link runSemanticFanOut}) to decide whether to re-throw a per-vault
 * rejection as fatal or capture it under `failed_vaults`.
 *
 * Most of these codes are thrown upstream of the fan-out callback today, so
 * the set acts mostly as defense in depth — but if a future tool routes any
 * of them from inside `fn(entry)`, the classification still does the right
 * thing.
 */
export const FATAL_TOOL_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_ARGUMENT',
  'INVALID_PARAMS',
  'INVALID_FILTER',
  'VAULT_REQUIRED',
  'VAULT_NOT_FOUND',
]);

export function isFatalToolError(error: unknown): error is ToolHandlerError {
  return error instanceof ToolHandlerError && FATAL_TOOL_ERROR_CODES.has(error.code);
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
