# Brainstorm — resource-error-envelope

Follow-up from #213 (`graph-read-errors`). The parent session's brief delegated the design forks
to this session. The user confirmed the resulting description in chat before any code was written.

## Background

A tool error reaches the client as a structured envelope: `toToolErrorResponse`
(`src/lib/tool-response.ts`) turns a `ToolHandlerError` into `isError: true` with
`structuredContent: { code, message, details }`. That is ADR-0003's contract.

A resource has no such envelope. `registerResource` (`src/lib/resource-registry.ts`) lets the
handler's error propagate to the SDK. The SDK's request handler (`shared/protocol.js`, SDK
1.29.0) builds the JSON-RPC error from three fields of the thrown object:

- `code`, only if `Number.isSafeInteger(error.code)`, else `-32603` (InternalError);
- `message`, else `'Internal error'`;
- `data`, only if `error.data !== undefined`.

`ToolHandlerError.code` is a string and it has no `data`. So a failed `vault://overview` read
answers `{ code: -32603, message: "Graph read failed" }`. `DEPENDENCY_ERROR` and
`details: { vault, operation }` are lost. #213 wrote that limit into the spec and the docs as a
known exception.

The overview resources are the only resources today, and `DEPENDENCY_ERROR` from
`graphForTool` is the only `ToolHandlerError` they throw on purpose. The fix belongs in
`registerResource`, so every future resource gets it.

## Decisions

**Q1. Where does the mapping live?** In `registerResource`'s handler wrapper, the resource-side
twin of `invokeTool`. Not in each resource, and not in `server.ts`, which only forwards
registrations.

**Q2. What carries the code?** JSON-RPC `error.data`: `{ code, details }`, with `details` left out
when the error has none. `message` is already the JSON-RPC message, so it is not repeated.

**Q3. Which JSON-RPC code?** `-32603` (InternalError) for every `ToolHandlerError`. It is what
clients get today, so the only wire change is the added `data`. Mapping fatal-class codes
(`INVALID_*`, `VAULT_*`) to `-32602` was weighed and dropped: a resource read has no parameters
but its URI, the SDK already answers an unknown URI with `-32602` itself, and the client
branches on `data.code`, not on the JSON-RPC number.

**Q4. `McpError` or a plain error?** Not `McpError`: its constructor rewrites the message to
`MCP error -32603: Graph read failed`, and the client SDK prefixes it again on receipt. The
wrapper throws an `Error` whose own `message` is the `ToolHandlerError`'s message, with a numeric
`code` and a `data` field. The JSON-RPC message stays `Graph read failed`, as today.

**Q5. What about the cause?** Unchanged: a `ToolHandlerError`'s `cause` never reaches the wire.
`graphForTool` already writes it to stderr. The resource URI, which is the error's
`details.operation`, now reaches the client. That is intended: it is the same `details` a tool
returns.

**Q6. Errors that are not `ToolHandlerError`?** Rethrown unchanged, so the SDK answers them as it
does today.

**Q7. ADR.** ADRs are immutable (ADR-0008). A new ADR-0023 extends ADR-0003's contract to
resources and records Q2–Q4. ADR-0003's index row gains "extended to resources by 0023".

**Q8. Test.** One test drives a failing resource through a real `McpServer` and SDK `Client`
over `InMemoryTransport`, and asserts the client's `McpError` carries `code: -32603`,
`data.code` and `data.details`. A second asserts a plain `Error` still arrives with no `data`.
The existing unit tests on `registerResource` stay.

## Size

A small change: one wrapper, one ADR, a spec delta, and three doc edits. It is opsx only because
it changes the error contract on the wire for every resource.
