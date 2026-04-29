import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import type { VaultProvider } from '../../../lib/obsidian/vault-provider.js';

const inputSchema = z.object({});

type Input = z.infer<typeof inputSchema>;

export interface ReadDailyDeps {
  provider: VaultProvider;
}

export function buildReadDailyTool(
  deps: ReadDailyDeps,
): ITool<Input, { path: string; frontmatter: Record<string, unknown> | null; content: string }> {
  const { provider } = deps;
  return {
    name: 'read_daily',
    title: 'Read Daily',
    description:
      "Read today's daily note. Returns `{ path, frontmatter, content }` where `frontmatter` is the parsed YAML object (or `null` if absent/malformed) and `content` is the body without the YAML block. Useful for 'what's on my agenda?' questions.",
    inputSchema,
    handler: async (_input) => {
      return provider.readDaily();
    },
  };
}
