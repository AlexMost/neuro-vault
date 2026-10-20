Tracked by: #214

## Why

A tool that fails with `ToolHandlerError` gives the client its `code` and `details`. A resource
that throws the same error gives only the message, because the MCP SDK keeps a thrown error's
`code` only when it is an integer and sends `data` only when the error has one. Since #213, a
failed graph read during a `vault://overview` read is `DEPENDENCY_ERROR` with
`details: { vault, operation }`, and the client sees neither. Clients cannot tell a retryable
dependency failure from a bug, and the spec has to carry a message-only exception for resources.

## What Changes

**A resource read error carries the `ToolHandlerError`'s code and details**
- From: a `ToolHandlerError` thrown by a resource handler reaches the client as JSON-RPC
  `-32603` with the message only.
- To: `registerResource` rethrows it as JSON-RPC `-32603` with the same message and
  `data: { code, details }` (`details` left out when the error has none). The cause stays off
  the wire. Any other error passes through unchanged.
- Reason: ADR-0003's contract (clients branch on a stable `code`) holds for tools only.
- Impact: not breaking. The JSON-RPC code and message are unchanged; `data` is added.

**The overview resource stops being an exception**
- From: the `shared-wikilink-graph` spec and the docs say a `vault://overview` read fails with
  the message only, and its code and URI reach only stderr.
- To: the read fails with `DEPENDENCY_ERROR` and `details: { vault, operation }` in `data`,
  where `operation` is the resource's URI. The cause still reaches only stderr.

**A new ADR-0023 extends ADR-0003 to resources.**

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tool-response-envelope`: adds how a resource read reports a `ToolHandlerError` and any other
  error.
- `shared-wikilink-graph`: a failed graph read during a `vault://overview` read reports
  `DEPENDENCY_ERROR` and `details` to the client.

## Impact

- **Code.** `src/lib/resource-registry.ts` (`registerResource`). The resources themselves are
  unchanged.
- **Tests.** `test/lib/resource-registry.test.ts`, through a real SDK server and client.
- **Docs.** New `docs/adr/0023-…`, the ADR index, `docs/architecture/mcp-server-shape.md`,
  `docs/architecture/wikilink-graph.md`, and `docs/guide/reading-and-modifying.md`.
- **Not here.** Mapping fatal-class codes to `-32602`, and any change to tool errors.
