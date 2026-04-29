import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { invalidArgument } from '../tool-helpers.js';
import type { VaultProvider } from '../../../lib/obsidian/vault-provider.js';

const inputSchema = z.object({
  content: z.string(),
});

type Input = z.infer<typeof inputSchema>;

export interface AppendDailyDeps {
  provider: VaultProvider;
}

export function buildAppendDailyTool(deps: AppendDailyDeps): ITool<Input, void> {
  const { provider } = deps;
  return {
    name: 'append_daily',
    title: 'Append Daily',
    description:
      "Append content to today's daily note. Use \\n for newlines. Common uses: log a thought, add a task, mark progress.",
    inputSchema,
    handler: async (input) => {
      if (input.content === undefined || input.content.trim() === '') {
        throw invalidArgument('content must not be empty', 'content');
      }
      return provider.appendDaily({ content: input.content });
    },
  };
}
