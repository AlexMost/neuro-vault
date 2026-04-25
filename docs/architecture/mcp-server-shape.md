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

## Tool handler contract

`src/tool-handlers.ts` returns a record of pure functions, one per tool. Each handler:

- Validates and normalizes its input (paths, queries, thresholds) and throws `ToolHandlerError('INVALID_ARGUMENT', ...)` on bad input.
- Calls the search engine / embedding provider / corpus.
- Wraps unexpected dependency failures via `wrapDependencyError`, which keeps the original cause but adds the operation name and `modelKey` to `details`.

Handlers are constructed via `createToolHandlers({ loader, embeddingProvider, searchEngine, modelKey })` — pure dependency injection, no module-level state. Tests inject mocks; runtime injects the real implementations.

## Boundaries

- The server file does not parse `.ajson`, embed text, or run cosine math. It only wires.
- Handlers do not log. Errors carry their own context; the server-level wrappers turn them into responses.
- Input schemas live next to handlers, not next to the search engine. Validation is a handler concern, not a search-engine concern.
