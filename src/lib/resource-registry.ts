import type { ResourceRegistration } from './resource-registration.js';

export interface IResource<O> {
  name: string;
  uri: string;
  title?: string;
  description: string;
  mimeType?: string;
  handler: (uri: URL) => Promise<O>;
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
      const payload = await resource.handler(uri);
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
