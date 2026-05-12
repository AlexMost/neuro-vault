import type { ReadResourceCallback } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface ResourceRegistrationMetadata {
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceRegistration {
  name: string;
  uri: string;
  metadata: ResourceRegistrationMetadata;
  handler: ReadResourceCallback;
}
