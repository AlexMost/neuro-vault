import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createSemanticModule, type ISemanticModuleDeps } from './modules/semantic/index.js';
import { createOperationsModule, type IOperationsModuleDeps } from './modules/operations/index.js';
import { VaultRegistry, type IVaultEntryDeps, type IVaultRegistry } from './lib/vault-registry.js';
import { FsVaultReader } from './lib/obsidian/vault-reader.js';
import { FsVaultWriter } from './lib/obsidian/vault-writer.js';
import { WikilinkGraphIndex } from './lib/obsidian/wikilink-graph.js';
import { createListMatchingPaths } from './lib/obsidian/query/index.js';
import { ObsidianCLIProvider } from './modules/operations/obsidian-cli-provider.js';
import { createSmartConnectionsCorpusIndex } from './lib/obsidian/smart-connections-corpus-index.js';
import type { ToolRegistration } from './lib/tool-registration.js';
import type { ResourceRegistration } from './lib/resource-registration.js';
import type { ServerConfig } from './types.js';

const require = createRequire(import.meta.url);
const { name: SERVER_NAME, version: SERVER_VERSION } = require('../package.json') as {
  name: string;
  version: string;
};

type ToolServer = Pick<McpServer, 'registerTool' | 'registerResource' | 'connect'>;

const EXTERNAL_AGENT_INSTRUCTIONS_PATH = '.neuro-vault/for-external-agents.md';

export async function readExternalAgentInstructions(vaultPath: string): Promise<string | null> {
  const filePath = path.join(vaultPath, EXTERNAL_AGENT_INSTRUCTIONS_PATH);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw.trim();
  } catch {
    return null;
  }
}

export interface NeuroVaultStartupDependencies {
  semantic?: ISemanticModuleDeps;
  operations?: IOperationsModuleDeps;
  vaultEntryDeps?: Partial<IVaultEntryDeps>;
  serverFactory?: (instructions: string) => ToolServer;
  transportFactory?: () => StdioServerTransport;
}

const STATIC_SERVER_INSTRUCTIONS = `\
This server provides two capability sets for an Obsidian vault: semantic search (when enabled) and direct vault operations (when enabled). Use the right one based on the user's intent.

## Role: a second brain alongside the project

This vault is the user's personal knowledge base — planning notes, brainstorm artifacts, decisions, reflections, drafts — that often predates and outlives any single project they bring to you. Before brainstorming new directions, drafting retrospectives, or answering "why did we decide X", check the vault first; the answer is often there but lives nowhere else.

You don't know on your own how the user scopes notes for the current project — the same vault is typically connected to many, and different users organise differently (a tag, a folder, a frontmatter property like \`project\`, or a combination). The user's project-level instructions should name that scope and tell you how to query for it. If they don't, you have three ways forward, in order of preference:

1. **Probe the vault structure** via \`get_vault_overview\` — a single-call snapshot of top-level folders with counts, top tags, frontmatter properties with inferred types, and the top-linked notes. Common conventions (a \`project\` frontmatter field, a \`Projects/\` folder, a recurring tag) usually surface immediately. Fall back to \`list_tags\`, \`list_properties\`, or exploratory \`query_notes\` only when the overview misses what you need.
2. **Use \`search_notes\`** with the project name and key concepts as a fuzzy entry point — relevant material may exist under unrelated names.
3. **Ask the user**, and the first time they save project-specific notes propose a scoping scheme so future sessions have an explicit entry point.

When operating directly inside the vault itself (not from an external project that connects to it), you have both filesystem access and MCP access to the same files. Prefer MCP tools — \`query_notes\` for structured filters, \`search_notes\` for semantic recall — over manually scanning files; they exist so frontmatter and similarity queries don't require reading every note.

## When to use vault operations

### Notes (body)

Use \`read_notes\`, \`create_note\`, \`edit_note\`, \`read_daily\` when the user asks to:
- Read one or more notes by path (\`read_notes\` — accepts a single vault-relative POSIX path string or an array of 1–50 such paths; prefer this over multiple sequential reads)
- Create a new note, task, or idea (\`create_note\`)
- Edit an existing note's body (\`edit_note\` — pass \`replace\` for exact-string find/replace, or omit it to overwrite the whole body. Frontmatter is never touched. If \`replace\` matches more than once, the call fails with \`AMBIGUOUS_MATCH\` listing the lines — make \`replace\` more specific or omit it to do a full rewrite). For "add at the end / start" use \`read_notes\` to fetch the body, modify it locally, and call \`edit_note\` without \`replace\`.
- Read today's daily note (\`read_daily\` returns \`{ path, frontmatter, content, notes_today }\`; \`notes_today\` lists notes created today excluding daily notes themselves, metadata only). To add content to today's daily, follow up with \`edit_note\` (omit \`replace\` for a full-body rewrite); if the daily note doesn't yet exist, use \`create_note\` with the path \`read_daily\` returns.

\`create_note\` with \`overwrite: true\` is destructive. Always ask the user before overwriting an existing note.

### Structured queries

Use \`query_notes\` for multi-criteria questions that combine tags, frontmatter properties, and ranges — for example "active projects with #ai", "todo tasks created this week", "notes with deadline set", "all notes tagged X". The \`filter\` is a MongoDB-style object evaluated against \`{ path, frontmatter, tags, backlink_count }\` — reference frontmatter keys as \`frontmatter.<key>\`, tags via the top-level \`tags\` field (no leading \`#\`), and \`backlink_count\` as a top-level scalar. Supported operators: \`$eq\`, \`$ne\`, \`$in\`, \`$nin\`, \`$gt\`, \`$gte\`, \`$lt\`, \`$lte\`, \`$exists\`, \`$regex\`, \`$options\`, \`$and\`, \`$or\`, \`$nor\`, \`$not\`. \`$regex\` is case-insensitive by default; pass \`$options\` (e.g. \`''\` for case-sensitive, \`'m'\` for multiline-only) to override. To list notes by a single tag use \`{ filter: { tags: 'X' } }\`. \`backlink_count\` is filterable (\`{ backlink_count: { $gte: 5 } }\`) and sortable (\`sort: { field: 'backlink_count', order: 'desc' }\`). The result \`{ results, count, truncated }\` includes \`frontmatter\` and \`backlink_count\` always; pass \`include_content: true\` only when bodies are needed up-front (it can grow the response a lot). Reads directly from disk; does not need Obsidian running. \`limit\` defaults to 100 and is capped at 1000.

### Frontmatter properties

Use \`set_property\`, \`read_property\`, \`remove_property\` when the user asks to read or modify a single YAML frontmatter field (status, due date, priority, etc.). Use \`list_properties\` to see what property names are already in use across the vault — useful before introducing a new one.

\`set_property\` infers \`type\` from the JS value (string→text, number→number, boolean→checkbox, array→list). For \`date\`/\`datetime\` you MUST pass \`type\` explicitly AND use ISO format (\`YYYY-MM-DD\` or \`YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]\`) — non-ISO values are silently dropped by the CLI, so the tool rejects them up front. Existing values are overwritten without asking.

If you need frontmatter for one or more notes, call \`read_notes\` with \`content: 'frontmatter'\` — that single batch call replaces N \`read_property\` calls when you have a list of paths.

### Tags

Use \`list_tags\` to see all tags ranked by frequency. To list the notes that carry a specific tag, call \`query_notes\` with \`{ filter: { tags: '<name>' } }\` (no leading \`#\`).

### Wikilink graph

Use \`get_note_links\` for "what links here / where does this point" questions about a single note. It returns the full \`{ incoming, outgoing }\` adjacency from the vault-wide wikilink graph (covers both \`[[X]]\` and \`![[X]]\` embeds, in body and frontmatter). \`outgoing\` entries carry \`resolved: bool\`; unresolved targets are kept verbatim — useful for surfacing concepts the user has anchored but not yet written. The same graph powers the \`backlink_count\` field on \`search_notes\` and \`query_notes\` results, which is the right signal when you only need ranking by inbound popularity rather than a full edge list.

### CLI availability

The vault-operations tools (other than \`read_notes\` and \`query_notes\`) route through the Obsidian CLI and require Obsidian to be running. If a call fails with \`CLI_NOT_FOUND\` or \`CLI_UNAVAILABLE\`, tell the user and stop — do not retry. \`read_notes\` and \`query_notes\` read directly from disk and do not need Obsidian to be running.

## When to use semantic search

Use \`search_notes\` when the user is recalling a topic fuzzily, asking a conceptual question, or does not know the exact note name. Use \`get_similar_notes\` after a relevant note is found to expand semantically related context.

### 1. Write the query
1. Extract the core nouns and concepts from the user's message — strip filler words and verbs. From "remind me what I wanted to build with LLM agents" the key concepts are "LLM", "agents", "build".
2. For synonyms, reformulations, or translations, pass \`query: string[]\` (1-8 strings) in a SINGLE call — the server batch-embeds all queries and returns one merged ranked list. \`limit\` always caps the final list regardless of how many queries you pass; passing more queries widens coverage but does not increase the result count.
3. The vault may contain notes written in several languages. If you have evidence of which languages are in use (from prior reads, file names, or earlier results), include translations of the key concepts into each of those languages in the same \`query\` array.
4. If a search returns no results, lower the threshold to 0.3 before giving up.

### 1a. Narrow scope when domain is known

If the query is about a known folder, tag, or frontmatter dimension, pass \`filter\` to scope semantic search to that subset BEFORE ranking. This dramatically improves precision when the vault has many narrative notes that crowd top-K. Shape: \`{ path_prefix?, tags?, frontmatter? }\` (at least one). Tags match ANY-of (OR). \`frontmatter\` accepts the same sift operators as \`query_notes\`. Examples: \`filter: { tags: ['trading'] }\`, \`filter: { path_prefix: 'Resources/', frontmatter: { type: 'reflection' } }\`.

### 2. Choose mode
- **quick** (default) — returns up to 3 notes plus block-level matches scoped to those notes. Use for specific lookups.
- **deep** — returns up to 8 notes plus block-level matches across the whole vault. After the merged top-\`limit\` seeds are selected, expansion runs once on those seeds to pull in related notes. Use for broad topics.
- Use \`limit\` to override the default note count in either mode. Widening \`limit\` widens recall.

### 3. Use the results
- \`results\` — top-level notes ranked by similarity. Each result carries \`backlink_count\` (vault-wide inbound wikilinks + embeds) — useful as a tiebreaker when scores are close.
- \`results[].blocks\` — section-level matches inside this note; use heading + line range to jump to the relevant part. Always present (possibly empty).
- \`results[].related\` — expansion neighbours of this note (deep mode only). Each item has \`path\` and \`expansion_similarity\` — a DIFFERENT scale from \`similarity\`; do not compare them numerically. Always present (possibly empty). The same neighbour may appear under multiple parents.
- \`matched_queries\` (only when \`query\` is an array) — which of your queries hit this note; lets you spot which synonym was load-bearing.
- \`truncated\` (only when \`query\` is an array) — true when unique merged candidates exceeded \`limit\`; widen \`limit\` to see more.
- After finding a relevant note, call \`get_similar_notes\` for a deeper neighbour profile.

## Routing between operations and semantic

If the user gives an exact anchor (note path, daily note, tag, frontmatter field), prefer operations tools. If the user is recalling fuzzily or asking a conceptual question, prefer \`search_notes\`. After semantic search finds a relevant note, you can read it with \`read_notes\` (passing the path as a single string, or batching with sibling paths in an array) to see the details.

For tag-driven questions ("which notes are tagged X?", "show me everything in #ai") use \`query_notes\` with \`{ filter: { tags: '<name>' } }\`, not \`search_notes\` — the answer is exact, not fuzzy.
`;

const GET_VAULT_OVERVIEW_HINT = `\
## Orientation

Before reaching for \`list_tags\`, \`list_properties\`, or exploratory \`query_notes\`, call \`get_vault_overview\` once at the start of a session. It returns the top-level folder layout with counts, the top tags, frontmatter properties with inferred types, the total note count, and the top 10 notes by inbound wikilinks — enough to orient yourself in a single call. The same payload is available as the MCP resource \`vault://overview\` for clients that auto-load resources.`;

export async function buildServerInstructions(registry: IVaultRegistry): Promise<string> {
  let result = STATIC_SERVER_INSTRUCTIONS;
  result += '\n\n' + GET_VAULT_OVERVIEW_HINT;

  if (registry.isMulti()) {
    const names = registry
      .names()
      .map((n) => `"${n}"`)
      .join(', ');
    result += `\n\n## Multi-vault mode\n\nThis server is registered with multiple vaults: ${names}. Every tool accepts an optional \`vault\` parameter. For broad recall, \`search_notes\`, \`query_notes\`, \`get_vault_overview\`, \`list_tags\`, and \`list_properties\` fan out across all vaults when \`vault\` is omitted; other tools (reads of specific paths, writes, single-vault diagnostics) require an explicit \`vault\` — omitting it returns \`VAULT_REQUIRED\`. Fan-out responses include \`results_by_vault\`, \`skipped_vaults\` (vaults pre-filtered out, e.g. missing semantic index), and \`failed_vaults\` (per-vault runtime errors with \`{ code, message, details? }\`) — a single failed vault does not abort the whole call. Path-shaped parameters (\`path\`, \`paths\`, \`path_prefix\`) remain vault-relative; vault identity is always carried by \`vault\`.`;
  }

  for (const entry of registry.list()) {
    const extra = await readExternalAgentInstructions(entry.path);
    if (extra !== null && extra !== '') {
      const heading = registry.isMulti()
        ? `## Vault-specific conventions — ${entry.name}`
        : '## Vault-specific conventions';
      result += `\n\n${heading}\n\n${extra}`;
    }
  }
  return result;
}

function defaultServerFactory(instructions: string): ToolServer {
  return new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions });
}

function defaultTransportFactory(): StdioServerTransport {
  return new StdioServerTransport();
}

function buildDefaultVaultEntryDeps(overrides: Partial<IVaultEntryDeps> = {}): IVaultEntryDeps {
  return {
    readerFactory: ({ vaultRoot }) => new FsVaultReader({ vaultRoot }),
    writerFactory: ({ vaultRoot }) => new FsVaultWriter({ vaultRoot }),
    graphFactory: ({ reader }) => new WikilinkGraphIndex({ reader }),
    listMatchingPathsFactory: ({ reader, graph }) => createListMatchingPaths({ reader, graph }),
    providerFactory: ({ vaultName, vaultRoot, binaryPath }) =>
      new ObsidianCLIProvider({ vaultName, vaultRoot, binaryPath }),
    corpusFactory: ({ smartEnvPath, modelKey }) =>
      createSmartConnectionsCorpusIndex({ smartEnvPath, modelKey }),
    ...overrides,
  };
}

export async function startNeuroVaultServer(
  config: ServerConfig,
  deps: NeuroVaultStartupDependencies = {},
): Promise<void> {
  const registry = await VaultRegistry.create(
    {
      vaults: config.vaults,
      semanticEnabled: config.semantic.enabled,
      modelKey: config.semantic.modelKey,
      binaryPath: config.obsidianCli,
    },
    buildDefaultVaultEntryDeps(deps.vaultEntryDeps),
  );

  const instructions = await buildServerInstructions(registry);
  const serverFactory = deps.serverFactory ?? defaultServerFactory;
  const transportFactory = deps.transportFactory ?? defaultTransportFactory;
  const server = serverFactory(instructions);

  const toolRegistrations: ToolRegistration[] = [];
  const resourceRegistrations: ResourceRegistration[] = [];
  let warmup: () => Promise<void> = async () => {};

  if (config.semantic.enabled) {
    const semantic = createSemanticModule(
      registry,
      { modelKey: config.semantic.modelKey, modelId: config.semantic.modelId },
      deps.semantic,
    );
    toolRegistrations.push(...semantic.tools);
    warmup = semantic.warmup;
  }

  const operations = createOperationsModule(registry, {}, deps.operations);
  toolRegistrations.push(...operations.tools);
  resourceRegistrations.push(...operations.resources);

  for (const tool of toolRegistrations) {
    server.registerTool(tool.name, tool.spec, tool.handler);
  }
  for (const resource of resourceRegistrations) {
    server.registerResource(resource.name, resource.uri, resource.metadata, resource.handler);
  }

  await server.connect(transportFactory());
  void warmup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`semantic warmup failed: ${message}\n`);
  });
}
