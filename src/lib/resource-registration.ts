import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

export interface ResourceRegistrationMetadata {
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceRegistration {
  name: string;
  uri: string;
  metadata: ResourceRegistrationMetadata;
  handler: (uri: URL) => Promise<ReadResourceResult>;
}
