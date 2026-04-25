import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createSemanticModule, type SemanticModuleDeps } from './modules/semantic/index.js';
import type { ServerConfig } from './types.js';

const require = createRequire(import.meta.url);
const { name: SERVER_NAME, version: SERVER_VERSION } = require('../package.json') as {
  name: string;
  version: string;
};

type ToolServer = Pick<McpServer, 'registerTool' | 'connect'>;

export interface NeuroVaultStartupDependencies {
  semantic?: SemanticModuleDeps;
  serverFactory?: () => ToolServer;
  transportFactory?: () => StdioServerTransport;
}

const SERVER_INSTRUCTIONS = `\
Vault search guidance for an Obsidian vault. Use when the user's vault may contain relevant context — their notes, projects, plans, tasks, learning materials, or ideas. This includes both direct requests ("find my notes on X") and questions where vault context would improve the answer ("what's on my agenda?", "what was I working on?").

## Search routing

1. Choose the search class first: structural or semantic.
2. If the user gives an exact anchor and structural tools are available, start there first.
3. Prefer Obsidian CLI when available for exact note, path, date, tag, property, and link lookups.
4. If Obsidian CLI is unavailable, use other structural file or navigation tools available in the current environment.
5. Structural anchors include exact note title or filename, explicit path or folder, daily note by date or relative date, tag/property/wikilink, backlinks, or link traversal.
6. Use \`search_notes\` when the user is recalling a topic fuzzily, asking a conceptual question, or does not know the exact note name.
7. After a relevant note is found, use \`get_similar_notes\` to expand semantically related context.

## Semantic search

### 1. Write the query
1. Extract the core nouns and concepts from the user's message — strip filler words and verbs. From "remind me what I wanted to build with LLM agents" the key concepts are "LLM", "agents", "build".
2. Search each concept separately and in small combinations: "LLM", "agents", "LLM agents", "AI projects".
3. Try synonyms and reformulations — the note may use different wording than the query.
4. The vault may contain notes in multiple languages. Search in the language of the user's message + English.
5. If a search returns no results, lower the threshold to 0.3 before giving up.

### 2. Choose mode
- **quick** (default) — returns up to 3 notes, no expansion. Use for specific lookups.
- **deep** — returns up to 8 notes + expands via similar notes. Use for broad topics.
- Pass \`expansion: true\` in quick mode if you want expansion there too.

### 3. Use the results
- \`results\` — notes ranked by similarity; read the file by path
- \`blockResults\` — sections ranked by relevance; use heading + line range to jump to the relevant part
- After finding a relevant note, call get_similar_notes to discover related content
`;

function defaultServerFactory(): ToolServer {
  return new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
}

function defaultTransportFactory(): StdioServerTransport {
  return new StdioServerTransport();
}

export async function startNeuroVaultServer(
  config: ServerConfig,
  deps: NeuroVaultStartupDependencies = {},
): Promise<void> {
  const serverFactory = deps.serverFactory ?? defaultServerFactory;
  const transportFactory = deps.transportFactory ?? defaultTransportFactory;
  const server = serverFactory();

  if (!config.semantic.enabled) {
    throw new Error('No modules enabled — pass --semantic or --operations');
  }

  const semantic = await createSemanticModule(
    {
      smartEnvPath: config.semantic.smartEnvPath,
      modelKey: config.semantic.modelKey,
      modelId: config.semantic.modelId,
    },
    deps.semantic,
  );

  for (const tool of semantic.tools) {
    server.registerTool(tool.name, tool.spec, tool.handler);
  }

  await server.connect(transportFactory());
  await semantic.warmup();
}
