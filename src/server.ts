import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { EmbeddingService } from './embedding-service.js';
import {
  loadSmartConnectionsCorpus,
  type SmartConnectionsCorpus,
} from './smart-connections-loader.js';
import { findBlockNeighbors, findDuplicates, findNeighbors } from './search-engine.js';
import { createToolHandlers, ToolHandlerError } from './tool-handlers.js';
import type {
  EmbeddingProvider,
  SearchEngine,
  ServerConfig,
  ToolHandlerDependencies,
  ToolHandlers,
} from './types.js';

const require = createRequire(import.meta.url);
const { name: SERVER_NAME, version: SERVER_VERSION } = require('../package.json') as {
  name: string;
  version: string;
};

const searchNotesSchema = z.object({
  query: z.string(),
  mode: z.enum(['quick', 'deep']).optional(),
  limit: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
  expansion: z.boolean().optional(),
  expansion_limit: z.number().int().positive().optional(),
});

const getSimilarNotesSchema = z.object({
  note_path: z.string(),
  limit: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
});

const findDuplicatesSchema = z.object({
  threshold: z.number().min(0).max(1).optional(),
});

type ToolServer = Pick<McpServer, 'registerTool' | 'connect'>;

type ToolContentBlock = {
  type: 'text';
  text: string;
};

type ToolResponse = CallToolResult;

export interface NeuroVaultServerDependencies {
  loader: {
    sources: Map<string, import('./types.js').SmartSource>;
  };
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
  toolHandlersFactory?: (deps: ToolHandlerDependencies) => ToolHandlers;
  serverFactory?: () => ToolServer;
}

export interface NeuroVaultStartupDependencies {
  loadCorpus?: (smartEnvPath: string, modelKey: string) => Promise<SmartConnectionsCorpus>;
  embeddingServiceFactory?: (modelKey: string) => EmbeddingProvider;
  searchEngine?: SearchEngine;
  toolHandlersFactory?: (deps: ToolHandlerDependencies) => ToolHandlers;
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
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );
}

function defaultTransportFactory(): StdioServerTransport {
  return new StdioServerTransport();
}

function toToolResponse(value: unknown): ToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ] satisfies ToolContentBlock[],
  };
}

function toToolErrorResponse(error: unknown): ToolResponse {
  if (error instanceof ToolHandlerError) {
    return {
      content: [
        {
          type: 'text',
          text: error.message,
        },
      ],
      structuredContent: {
        code: error.code,
        message: error.message,
        details: error.details ?? null,
      },
      isError: true,
    };
  }

  const message = error instanceof Error ? error.message : 'Unknown tool error';

  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    structuredContent: {
      message,
    },
    isError: true,
  };
}

async function invokeTool<T>(handler: () => Promise<T>): Promise<ToolResponse> {
  try {
    const value = await handler();
    return toToolResponse(value);
  } catch (error) {
    return toToolErrorResponse(error);
  }
}

export function createNeuroVaultServer({
  loader,
  embeddingProvider,
  searchEngine,
  modelKey,
  toolHandlersFactory = createToolHandlers,
  serverFactory = defaultServerFactory,
}: NeuroVaultServerDependencies): ToolServer {
  const server = serverFactory();
  const handlers = toolHandlersFactory({
    loader,
    embeddingProvider,
    searchEngine,
    modelKey,
  });

  server.registerTool(
    'search_notes',
    {
      title: 'Search Notes',
      description:
        'Search notes by semantic similarity for fuzzy recall, topic lookup, or cross-language matching. Pass a short keyword query (1-4 words). Choose mode: "quick" for specific lookups (up to 3 notes), "deep" for broad topic overview with block-level search and expansion. Call multiple times with different queries for synonyms or multi-language searches.',
      inputSchema: searchNotesSchema,
    },
    async (args) => invokeTool(() => handlers.searchNotes(args)),
  );

  server.registerTool(
    'get_similar_notes',
    {
      title: 'Get Similar Notes',
      description:
        'Find semantically related notes after you already have a relevant note path. Pass a vault-relative POSIX path (e.g. "Folder/note.md").',
      inputSchema: getSimilarNotesSchema,
    },
    async (args) => invokeTool(() => handlers.getSimilarNotes(args)),
  );

  server.registerTool(
    'find_duplicates',
    {
      title: 'Find Duplicates',
      description: 'Identify note pairs with high embedding similarity.',
      inputSchema: findDuplicatesSchema,
    },
    async (args) => invokeTool(() => handlers.findDuplicates(args)),
  );

  server.registerTool(
    'get_stats',
    {
      title: 'Get Stats',
      description: 'Report corpus and embedding statistics.',
    },
    async () => invokeTool(() => handlers.getStats()),
  );

  return server;
}

function ensureCorpusIsUsable(corpus: SmartConnectionsCorpus): void {
  if (corpus.sources.size === 0) {
    throw new Error('Loaded Smart Connections corpus is empty');
  }
}

export async function startNeuroVaultServer(
  config: ServerConfig,
  deps: NeuroVaultStartupDependencies = {},
): Promise<void> {
  const loadCorpus = deps.loadCorpus ?? loadSmartConnectionsCorpus;
  const embeddingServiceFactory =
    deps.embeddingServiceFactory ??
    ((modelId: string) => new EmbeddingService({ modelKey: modelId }));
  const searchEngine = deps.searchEngine ?? { findNeighbors, findBlockNeighbors, findDuplicates };
  const serverFactory = deps.serverFactory ?? defaultServerFactory;
  const transportFactory = deps.transportFactory ?? defaultTransportFactory;

  const corpus = await loadCorpus(config.smartEnvPath, config.modelKey);
  ensureCorpusIsUsable(corpus);

  const embeddingService = embeddingServiceFactory(config.modelId);

  const server = createNeuroVaultServer({
    loader: corpus,
    embeddingProvider: embeddingService,
    searchEngine,
    modelKey: config.modelKey,
    toolHandlersFactory: deps.toolHandlersFactory,
    serverFactory,
  });

  await server.connect(transportFactory());

  embeddingService.initialize().catch(() => {
    /* model will be loaded lazily on first search if pre-warm fails */
  });
}
