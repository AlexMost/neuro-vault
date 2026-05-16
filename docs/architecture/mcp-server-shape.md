# MCP Server Shape

How the server exposes tools to MCP clients and how tool failures become structured responses.

## What it is

`src/server.ts` builds an `McpServer` (from `@modelcontextprotocol/sdk`) and registers each tool by name with three things: a zod input schema, a tool description, and an async handler. Every handler runs through a small wrapper that converts return values and exceptions into MCP `CallToolResult` objects.

## Why it exists

MCP tools must return a uniform shape: `{ content, structuredContent?, isError? }`. Without a wrapper, every handler would duplicate that boilerplate. The wrapper also gives a single place to translate domain errors (`ToolHandlerError`) into the structured `{ code, message, details }` payload that clients can branch on.

## How it interacts

```
McpServer.registerTool(name, { title, description, inputSchema }, handler)
  │
  ▼
async (args) => invokeTool(() => handlers.foo(args))
  │
  ├─ success → toToolResponse(value) — JSON-stringified into a text content block
  └─ error   → toToolErrorResponse(error)
                 ├─ ToolHandlerError → structured { code, message, details }
                 └─ anything else    → { message }
```

`server.ts` is also where the server's `instructions` text lives — the long string that documents tool routing for the LLM. The description on each individual tool covers what that one tool does; the server-level instructions cover when to reach for vault tooling at all.

The instructions are no longer static. `buildServerInstructions(registry)` composes them at startup from several layers:

1. A fixed base — routing rules, role description, tool guidance.
2. An always-on orientation hint pointing at `get_vault_overview` / `vault://overview`.
3. When `registry.isMulti()` returns `true`, an additional `## Multi-vault mode` section listing every registered vault name and explaining the fan-out vs. `VAULT_REQUIRED` contract.
4. Per-vault vault-specific conventions — the content of `<vaultPath>/.neuro-vault/for-external-agents.md` when present. In single-vault mode the heading is `## Vault-specific conventions`; in multi-vault mode each vault gets its own heading, `## Vault-specific conventions — <vault-name>`. Missing or unreadable files fall back gracefully; the block is simply omitted.

Resources are registered through the same module aggregation as tools. Each module returns `{ tools, resources }`; the server iterates both lists and calls `server.registerTool` / `server.registerResource` respectively. The resource scaffolding lives in `src/lib/resource-registration.ts` and `src/lib/resource-registry.ts`, mirroring the tool primitives.

## Resource URIs in single-vault vs. multi-vault mode

The operations module's vault-overview resource changes URI shape based on vault count:

- **Single-vault**: `vault://overview` — one resource, no vault name in the URI. Preserves existing client wiring for users upgrading from v5.
- **Multi-vault**: one resource per vault, at `vault://<vault-name>/overview`. Clients that auto-load resources by URI get one snapshot per vault.

The asymmetry is deliberate. Single-vault users who have already wired `vault://overview` into their client config do not need to change anything. Multi-vault users get URIs that are unambiguous about which vault they describe.

The selection logic lives in `src/modules/operations/resources/index.ts`; the per-vault resource builder is `src/modules/operations/resources/vault-overview.ts`.

## Tool handler contract

There is no central tool-handlers module. Each tool lives in its own file under `src/modules/<module>/tools/<name>.ts` and exports a `buildXTool(deps)` factory that returns an `ITool<I, O>` — name, title, description, zod input schema, and an async `handler`. Each handler:

- Validates and normalizes its input (paths, queries, thresholds) and throws `ToolHandlerError('INVALID_ARGUMENT', ...)` on bad input.
- Calls the search engine / embedding provider / corpus / Obsidian CLI provider via the dependencies passed into its factory.
- Wraps unexpected dependency failures via `wrapDependencyError`, which keeps the original cause but adds the operation name and `modelKey` to `details`.

Per-module aggregators (`src/modules/semantic/tools/index.ts`, `src/modules/operations/tools/index.ts`) compose every tool factory with its dependencies and return a list of `ToolRegistration` objects via the `registerTool` helper from `src/lib/tool-registry.ts`. Dependencies (vault registry, search engine, embedding provider, modelKey) are passed into the factories — pure dependency injection, no module-level state. Tests inject mocks; runtime injects the real implementations.

## Boundaries

- The server file does not parse `.ajson`, embed text, or run cosine math. It only wires.
- Handlers do not log. Errors carry their own context; the server-level wrappers turn them into responses.
- Input schemas live next to handlers, not next to the search engine. Validation is a handler concern, not a search-engine concern.
