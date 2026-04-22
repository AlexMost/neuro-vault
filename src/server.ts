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
import { findDuplicates, findNeighbors } from './search-engine.js';
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
  limit: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
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
This server provides semantic search over an Obsidian vault using Smart Connections embeddings.

## Search strategy

Semantic search works best with short, focused queries (1-4 words). Long sentences or full questions dilute the signal and often return no results.

When looking for information:
1. Extract the core nouns and concepts from the user's message — strip away filler words, verbs, and context. For example, from "remind me what I wanted to build with LLM agents" the key concepts are "LLM", "agents", "build" — not the full sentence.
2. Start with several SHORT keyword queries rather than one long phrase. Search each key concept separately and in small combinations. For example, try: "LLM", "agents", "LLM agents", "AI projects".
3. Try synonyms and reformulations — the note may use different wording than the query.
3. The vault may contain notes in multiple languages. Try queries in each language the user speaks (e.g. both Ukrainian and English).
4. If a search returns no results, lower the threshold to 0.3 before giving up.
5. Once you find a relevant note, use get_similar_notes to discover related content.

## Reading results

Search results include block headings and line ranges — use these as pointers to read specific sections of the matched notes rather than reading entire files.
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
        'Search notes by semantic similarity. Use short keyword queries (1-4 words), not full sentences. Make multiple calls with different keywords, synonyms, and languages to get comprehensive results. Lower the threshold (e.g. 0.3) if no results are found.',
      inputSchema: searchNotesSchema,
    },
    async (args) => invokeTool(() => handlers.searchNotes(args)),
  );

  server.registerTool(
    'get_similar_notes',
    {
      title: 'Get Similar Notes',
      description:
        'Find notes similar to a given note. Use this after search_notes finds a relevant note — it discovers related content without needing a text query. Pass a vault-relative POSIX path (e.g. "Folder/note.md").',
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
  const searchEngine = deps.searchEngine ?? { findNeighbors, findDuplicates };
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
