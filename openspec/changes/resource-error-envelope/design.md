## Context

`registerResource` (`src/lib/resource-registry.ts`) wraps a resource's handler in the SDK's
`ReadResourceCallback` and lets any error propagate. The SDK (1.29.0, `shared/protocol.js`)
answers a rejected request with `code: Number.isSafeInteger(error.code) ? error.code : -32603`,
`message: error.message`, and `data` only when `error.data !== undefined`.
`ToolHandlerError.code` is a string and the class has no `data`, so a resource client sees the
message and nothing else. Tools do not have this gap: `invokeTool` turns a `ToolHandlerError`
into `structuredContent: { code, message, details }` (ADR-0003). The only resources today are
the `vault://overview` resources, and since #213 they throw `DEPENDENCY_ERROR` from
`graphForTool` when a graph read fails (brainstorm.md, Background).

## Goals / Non-Goals

**Goals:**
- A `ToolHandlerError` thrown by any resource handler reaches the client with its `code` and
  `details` in JSON-RPC `error.data`, and its message unchanged.
- The mapping lives in one place, `registerResource`.
- A test proves it on the wire: a real `McpServer` and SDK `Client` over `InMemoryTransport`.

**Non-Goals:**
- Changing tool errors, or the JSON-RPC code clients see today.
- Mapping errors that are not `ToolHandlerError`.
- Changing what the overview resources throw.

## Decisions

### D1: `registerResource` maps the error
- **Choice**: the handler wrapper catches a `ToolHandlerError` and throws a `ResourceReadError`
  in its place. Any other error is rethrown as is.
- **Why**: it is the resource-side twin of `invokeTool`, so every resource gets it, today's and
  later ones.
- **Alternatives considered**: a `try/catch` in each resource (a per-resource copy), or in
  `server.ts` (which only forwards registrations and would wrap callbacks it does not own).

### D2: `data` is `{ code, details }`
- **Choice**: `data: { code }`, plus `details` when the error has them.
- **Why**: `message` is already the JSON-RPC message; repeating it adds nothing a client branches
  on.
- **Alternatives considered**: `{ code, message, details }`, the tools' `structuredContent`
  shape. Same information, one field duplicated.

### D3: The JSON-RPC code stays `-32603`
- **Choice**: every `ToolHandlerError` keeps `-32603` (InternalError).
- **Why**: it is what clients get today, so the only wire change is the added `data`. The client
  branches on `data.code`.
- **Alternatives considered**: `-32602` for fatal-class codes (`INVALID_*`, `VAULT_*`). A resource
  read has no parameters but its URI, and the SDK already answers an unknown URI with `-32602`
  itself.

### D4: A plain error class, not `McpError`
- **Choice**: `ResourceReadError extends Error` with a numeric `code` and `data`, local to
  `resource-registry.ts`. Its message is the `ToolHandlerError`'s message, and it keeps the
  original as `cause` for in-process callers.
- **Why**: `McpError`'s constructor rewrites the message to `MCP error -32603: <message>`, and the
  client SDK prefixes it again on receipt. The SDK reads only `code`, `message` and `data`, so the
  `cause` never reaches the wire.
- **Alternatives considered**: `McpError` (message rewritten); an object literal (not an `Error`,
  no stack).

### D5: The ADR
- **Choice**: a new ADR-0023 extends ADR-0003's contract to resources and records D2–D4.
  ADR-0003's index row reads "extended to resources by 0023". ADR-0003 is not edited: ADRs are
  immutable (ADR-0008).

## Risks / Trade-offs

- [Risk] A future SDK version changes how it reads a thrown error (for example, wraps it in
  `McpError`). → Mitigation: the test goes through the real SDK server and client, so a change
  fails it.
- [Trade-off] The resource URI (`details.operation`) now reaches the client. → Accepted: it is
  the URI the client asked for, and the same `details` a tool returns. The cause still reaches
  only stderr.
- [Risk] A test asserts `data` but not that the message is unprefixed. → Mitigation: the SDK test
  asserts the client-side message equals `MCP error -32603: Graph read failed` (one prefix, added
  by the client).

## Migration Plan

N/A. No deploy or data change. Clients that read only the message see the same message.

## Open Questions

None.
