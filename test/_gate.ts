import { expect } from 'vitest';

import type { ToolRegistration } from '../src/lib/tool-registration.js';
import { ToolHandlerError } from '../src/lib/tool-response.js';

export interface ToolErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

function firstText(result: Awaited<ReturnType<ToolRegistration['handler']>>): string {
  const block = result.content?.find((c): c is { type: 'text'; text: string } => c.type === 'text');
  if (block === undefined) {
    throw new Error('callTool: tool result carried no text content block');
  }
  return block.text;
}

/**
 * Call a tool the way an MCP client does: through the registration, so the
 * coercing, `.strict()` input gate runs first. Success payloads come back
 * unwrapped; gate and handler rejections are re-thrown as `ToolHandlerError`
 * so `rejects.toMatchObject({ code })` reads the same as it did when tests
 * called the raw handler.
 *
 * `toToolResponse` only sets `structuredContent` for a plain record, so array
 * payloads (`find_duplicates`, `get_similar_notes`) arrive in the text channel
 * alone — read them the way a client that ignores `structuredContent` does.
 */
export async function callTool<T>(reg: ToolRegistration, args: unknown): Promise<T> {
  const result = await reg.handler(args);
  if (result.isError === true) {
    const payload = result.structuredContent as Partial<ToolErrorPayload> | undefined;
    throw new ToolHandlerError(
      payload?.code ?? 'UNKNOWN_ERROR',
      payload?.message ?? 'tool returned isError with no structured payload',
      payload?.details === undefined ? undefined : { details: payload.details },
    );
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const text = firstText(result);
  if (text === 'ok') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `callTool: ${reg.name} resolved with no structuredContent and non-JSON text: ${text}`,
    );
  }
}

/** For tests whose subject is the error envelope itself rather than a throw. */
export async function expectToolError(
  reg: ToolRegistration,
  args: unknown,
): Promise<ToolErrorPayload> {
  const result = await reg.handler(args);
  expect(result.isError).toBe(true);
  return result.structuredContent as unknown as ToolErrorPayload;
}
