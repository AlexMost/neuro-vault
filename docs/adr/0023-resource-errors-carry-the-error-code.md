# ADR-0023 — Resource read errors carry the error code in JSON-RPC `data`

- **Status**: Accepted
- **Date**: 2026-10-20

## Context

[ADR-0003](0003-structured-errors-toolhandlererror.md) makes every tool error a `ToolHandlerError` and renders it into a structured `{ code, message, details }` payload. That rendering lives in the tool envelope (`invokeTool`), and a resource read has no such envelope. When a resource handler throws, the MCP SDK builds the JSON-RPC error from three fields of the thrown object: `code` (kept only when it is an integer, otherwise `-32603` InternalError), `message`, and `data` (sent only when set). `ToolHandlerError.code` is a string and the class has no `data`, so a resource client saw the message and nothing else. Since #213, a failed graph read during a `vault://overview` read is a `DEPENDENCY_ERROR` with `details: { vault, operation }`, and the client could not see either.

## Decision

`registerResource` (`src/lib/resource-registry.ts`) owns the mapping, as `invokeTool` does for tools. A `ToolHandlerError` thrown by a resource handler is rethrown as a `ResourceReadError`: JSON-RPC code `-32603`, the `ToolHandlerError`'s message unchanged, and `data: { code, details }`, with `details` left out when the error has none. The cause never reaches the wire. Any other error is rethrown unchanged.

## Consequences

- ADR-0003's contract holds for resources too: a client branches on `data.code`, as it branches on `structuredContent.code` for a tool. Every resource gets it, including later ones.
- The JSON-RPC code and message are what clients got before, so the change only adds `data`.
- A resource read's `details` reach the client. For the overview resources that includes `operation`, the URI the client asked for.
- The mapping depends on how the SDK serialises a thrown error. A test reads a failing resource through a real `McpServer` and SDK `Client`, so an SDK change that breaks it fails the suite.

## Alternatives considered

- **`McpError` instead of a local class** — its constructor rewrites the message to `MCP error -32603: <message>`, and the client SDK adds the prefix again on receipt.
- **`-32602` (InvalidParams) for fatal-class codes** — a resource read has no parameters but its URI, and the SDK already answers an unknown URI with `-32602` itself. The client branches on `data.code`, not the JSON-RPC number.
- **`data: { code, message, details }`, the tools' shape** — `message` is already the JSON-RPC message.
