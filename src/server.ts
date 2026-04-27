import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createSemanticModule, type SemanticModuleDeps } from './modules/semantic/index.js';
import { createOperationsModule, type OperationsModuleDeps } from './modules/operations/index.js';
import type { ToolRegistration } from './lib/tool-registration.js';
import type { ServerConfig } from './types.js';

const require = createRequire(import.meta.url);
const { name: SERVER_NAME, version: SERVER_VERSION } = require('../package.json') as {
  name: string;
  version: string;
};

type ToolServer = Pick<McpServer, 'registerTool' | 'connect'>;

export interface NeuroVaultStartupDependencies {
  semantic?: SemanticModuleDeps;
  operations?: OperationsModuleDeps;
  serverFactory?: () => ToolServer;
  transportFactory?: () => StdioServerTransport;
}

const SERVER_INSTRUCTIONS = `\
This server provides two capability sets for an Obsidian vault: semantic search (when enabled) and direct vault operations (when enabled). Use the right one based on the user's intent.

## When to use vault operations

### Notes (body)

Use \`read_notes\`, \`create_note\`, \`edit_note\`, \`read_daily\`, \`append_daily\` when the user asks to:
- Read one or more notes by path (\`read_notes\` — accepts an array of 1–50 vault-relative POSIX paths; prefer this over multiple sequential reads)
- Create a new note, task, or idea (\`create_note\`)
- Add content to an existing note (\`edit_note\`)
- Read or update today's daily note (\`read_daily\` / \`append_daily\`)

\`create_note\` with \`overwrite: true\` is destructive. Always ask the user before overwriting an existing note.

### Structured queries

Use \`query_notes\` for multi-criteria questions that combine tags, frontmatter properties, and ranges — for example "active projects with #ai", "todo tasks created this week", "notes with deadline set". The \`filter\` is a MongoDB-style object evaluated against \`{ path, frontmatter, tags }\` — reference frontmatter keys as \`frontmatter.<key>\` and tags via the top-level \`tags\` field (no leading \`#\`). Supported operators: \`$eq\`, \`$ne\`, \`$in\`, \`$nin\`, \`$gt\`, \`$gte\`, \`$lt\`, \`$lte\`, \`$exists\`, \`$regex\`, \`$and\`, \`$or\`, \`$nor\`, \`$not\`. Prefer \`query_notes\` over \`get_tag\` + \`read_property × N\` whenever the question has more than one criterion. The result \`{ results, count, truncated }\` includes \`frontmatter\` always; pass \`include_content: true\` only when bodies are needed up-front (it can grow the response a lot). Reads directly from disk; does not need Obsidian running. \`limit\` defaults to 100 and is capped at 1000.

### Frontmatter properties

Use \`set_property\`, \`read_property\`, \`remove_property\` when the user asks to read or modify a single YAML frontmatter field (status, due date, priority, etc.). Use \`list_properties\` to see what property names are already in use across the vault — useful before introducing a new one.

\`set_property\` infers \`type\` from the JS value (string→text, number→number, boolean→checkbox, array→list). For \`date\`/\`datetime\` you MUST pass \`type\` explicitly AND use ISO format (\`YYYY-MM-DD\` or \`YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]\`) — non-ISO values are silently dropped by the CLI, so the tool rejects them up front. Existing values are overwritten without asking.

If you need frontmatter for one or more notes, call \`read_notes\` with \`fields: ['frontmatter']\` — that single batch call replaces N \`read_property\` calls when you have a list of paths.

### Tags

Use \`list_tags\` to see all tags ranked by frequency, and \`get_tag\` to find which files use a specific tag. Pass \`include_files: false\` to \`get_tag\` for very popular tags where the full file list would be large. The leading \`#\` on tag names is optional — both \`ai\` and \`#ai\` work.

### CLI availability

The vault-operations tools (other than \`read_notes\` and \`query_notes\`) route through the Obsidian CLI and require Obsidian to be running. If a call fails with \`CLI_NOT_FOUND\` or \`CLI_UNAVAILABLE\`, tell the user and stop — do not retry. \`read_notes\` and \`query_notes\` read directly from disk and do not need Obsidian to be running.

## When to use semantic search

Use \`search_notes\` when the user is recalling a topic fuzzily, asking a conceptual question, or does not know the exact note name. Use \`get_similar_notes\` after a relevant note is found to expand semantically related context.

### 1. Write the query
1. Extract the core nouns and concepts from the user's message — strip filler words and verbs. From "remind me what I wanted to build with LLM agents" the key concepts are "LLM", "agents", "build".
2. For synonyms, reformulations, or translations, pass \`query\` as an array of 1-8 strings in a SINGLE call — the server batch-embeds them and returns one merged ranked list with \`matched_queries\` showing which query hit which note. Do not make multiple sequential calls for synonyms.
3. The vault may contain notes written in several languages. If you have evidence of which languages are in use (from prior reads, file names, or earlier results), include translations of the key concepts into each of those languages in the same \`query\` array.
4. If a search returns no results, lower the threshold to 0.3 before giving up.

### 2. Choose mode
- **quick** (default) — returns up to 3 notes plus block-level matches scoped to those notes. Use for specific lookups.
- **deep** — returns up to 8 notes plus block-level matches across the whole vault, with semantic expansion to related notes. Use for broad topics.
- Use \`limit\` to override the default note count in either mode.

### 3. Use the results
- \`results\` — notes ranked by similarity; read the file by path
- \`matched_queries\` (only when \`query\` is an array) — which of your queries hit this note; lets you spot which synonym was load-bearing
- \`truncated\` (only when \`query\` is an array) — true when more candidates were merged than fit in the cap
- \`blockResults\` — sections ranked by relevance; use heading + line range to jump to the relevant part
- After finding a relevant note, call get_similar_notes to discover related content

## Routing between operations and semantic

If the user gives an exact anchor (note path, daily note, tag, frontmatter field), prefer operations tools. If the user is recalling fuzzily or asking a conceptual question, prefer \`search_notes\`. After semantic search finds a relevant note, you can read it with \`read_notes\` (passing the path in a one-element array, or batching with sibling paths) to see the details.

For tag-driven questions ("which notes are tagged X?", "show me everything in #ai") use \`get_tag\`, not \`search_notes\` — the answer is exact, not fuzzy.
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
  if (!config.semantic.enabled && !config.operations.enabled) {
    throw new Error('No modules enabled — pass --semantic or --operations');
  }

  const serverFactory = deps.serverFactory ?? defaultServerFactory;
  const transportFactory = deps.transportFactory ?? defaultTransportFactory;
  const server = serverFactory();

  const registrations: ToolRegistration[] = [];
  let warmup: () => Promise<void> = async () => {};

  if (config.semantic.enabled) {
    const semantic = await createSemanticModule(
      {
        vaultPath: config.vaultPath,
        smartEnvPath: config.semantic.smartEnvPath,
        modelKey: config.semantic.modelKey,
        modelId: config.semantic.modelId,
      },
      deps.semantic,
    );
    registrations.push(...semantic.tools);
    warmup = semantic.warmup;
  }

  if (config.operations.enabled) {
    const operations = createOperationsModule(
      {
        vaultPath: config.vaultPath,
        binaryPath: config.operations.binaryPath,
      },
      deps.operations,
    );
    registrations.push(...operations.tools);
  }

  for (const tool of registrations) {
    server.registerTool(tool.name, tool.spec, tool.handler);
  }

  await server.connect(transportFactory());
  void warmup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`semantic warmup failed: ${message}\n`);
  });
}
