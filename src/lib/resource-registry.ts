import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import type { ResourceRegistration } from './resource-registration.js';
import { ToolHandlerError } from './tool-response.js';

export interface IResource<O> {
  name: string;
  uri: string;
  title?: string;
  description: string;
  mimeType?: string;
  handler: (uri: URL) => Promise<O>;
}

export interface ResourceErrorData {
  code: string;
  details?: Record<string, unknown>;
}

/**
 * A `ToolHandlerError` as the SDK puts it on the wire for a resource read
 * (ADR-0023). The SDK builds the JSON-RPC error from a thrown error's `code`
 * (kept only when it is an integer), `message` and `data`, so this carries
 * `InternalError`, the original message unprefixed, and `{ code, details }`.
 * The original error rides along as `cause`, which the SDK never sends.
 */
export class ResourceReadError extends Error {
  readonly code = ErrorCode.InternalError;
  readonly data: ResourceErrorData;

  constructor(error: ToolHandlerError) {
    super(error.message, { cause: error });
    this.name = 'ResourceReadError';
    this.data = {
      code: error.code,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
}

export function registerResource<O>(resource: IResource<O>): ResourceRegistration {
  const mimeType = resource.mimeType ?? 'application/json';
  return {
    name: resource.name,
    uri: resource.uri,
    metadata: {
      ...(resource.title !== undefined ? { title: resource.title } : {}),
      description: resource.description,
      mimeType,
    },
    handler: async (uri) => {
      let payload: O;
      try {
        payload = await resource.handler(uri);
      } catch (error) {
        throw error instanceof ToolHandlerError ? new ResourceReadError(error) : error;
      }
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return {
        contents: [
          {
            uri: resource.uri,
            mimeType,
            text,
          },
        ],
      };
    },
  };
}
