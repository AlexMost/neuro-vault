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

`server.ts` is also where the server's `instructions` text lives, as the module constant `SERVER_INSTRUCTIONS`. It composes nothing at startup: it takes no registry, reads no file, and is byte-identical for every configuration. It is deliberately short. Claude Code truncates `instructions` at 2048 characters and hands sub-agents none of it, whereas every tool `description` reaches every client in full — so anything a tool can say about itself (parameters, result shape, multi-vault behaviour) belongs on that tool, not here. That principle is recorded in [ADR-0010](../adr/0010-context-delivery-channels.md); [ADR-0012](../adr/0012-conventions-leave-the-instructions-channel.md) is why the constant carries no vault content either.

The constant's last paragraph points at `get_vault_overview` for a vault's owner-authored conventions. How that delivery actually works — the `conventions` field, its 8,000-character cap, its truncation flag, and its per-vault fan-out — is owned by [vault-conventions.md](./vault-conventions.md).

Resources are registered through the same module aggregation as tools. Each module returns `{ tools, resources }`; the server iterates both lists and calls `server.registerTool` / `server.registerResource` respectively. The resource scaffolding lives in `src/lib/resource-registration.ts` and `src/lib/resource-registry.ts`, mirroring the tool primitives.

## Resource URIs in single-vault vs. multi-vault mode

The operations module's vault-overview resource changes URI shape based on vault count:

- **Single-vault**: `vault://overview` — one resource, no vault name in the URI. Preserves existing client wiring for users upgrading from v5.
- **Multi-vault**: one resource per vault, at `vault://<vault-name>/overview`. Clients that auto-load resources by URI get one snapshot per vault.

The asymmetry is deliberate. Single-vault users who have already wired `vault://overview` into their client config do not need to change anything. Multi-vault users get URIs that are unambiguous about which vault they describe.

The selection logic lives in `src/modules/operations/resources/index.ts`; the per-vault resource builder is `src/modules/operations/resources/vault-overview.ts`.

## Startup and shutdown own background work

Registering tools is not the only thing `startNeuroVaultServer` does. Each vault entry's `backend` (`src/lib/vault-registry.ts`) may hold a live `chokidar` watcher — a handle that keeps the Node event loop open on its own — so the server must release it explicitly rather than let the process exit around it (see [`semantic-backend.md`](./semantic-backend.md) and [ADR-0014](../adr/0014-background-corpus-freshness.md)).

`startNeuroVaultServer` builds a `dispose()` that calls every vault entry's `backend?.dispose()` via `Promise.allSettled`, so one vault's disposal failure is reported to stderr without blocking the others. It chains that disposer onto the MCP SDK's own `transport.onclose` — never replacing it, only wrapping it in a `finally` — so a client disconnecting still takes the watchers down with it. `startNeuroVaultServer` also returns `dispose` directly, for callers (tests, and any future caller that shuts the server down itself) that need to release these resources without waiting on a transport close; `cli.ts` ignores the return value and lets `onclose` do the work.

## Tool handler contract

There is no central tool-handlers module. Each tool lives in its own file under `src/modules/<module>/tools/<name>.ts` and exports a `buildXTool(deps)` factory that returns an `ITool<I, O>` — name, title, description, zod input schema, and an async `handler`. Each handler:

- Validates and normalizes its input (paths, queries, thresholds) and throws `ToolHandlerError('INVALID_ARGUMENT', ...)` on bad input.
- Calls the search engine / embedding provider / corpus / vault provider via the dependencies passed into its factory.
- Wraps unexpected dependency failures via `wrapDependencyError`, which keeps the original cause but adds the operation name and `modelKey` to `details`.

Per-module aggregators (`src/modules/semantic/tools/index.ts`, `src/modules/operations/tools/index.ts`) compose every tool factory with its dependencies and return a list of `ToolRegistration` objects via the `registerTool` helper from `src/lib/tool-registry.ts`. Dependencies (vault registry, search engine, embedding provider, modelKey) are passed into the factories — pure dependency injection, no module-level state. Tests inject mocks; runtime injects the real implementations.

## Boundaries

- The server file does not parse `.ajson`, embed text, or run cosine math. It only wires.
- Handlers do not log. Errors carry their own context; the server-level wrappers turn them into responses.
- Input schemas live next to handlers, not next to the search engine. Validation is a handler concern, not a search-engine concern.
