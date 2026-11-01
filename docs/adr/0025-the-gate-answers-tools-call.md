# ADR-0025 — The gate answers `tools/call`; the SDK only lists the tools

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

[ADR-0015](0015-input-gate-owns-schema-validation.md) makes the registration gate the owner of schema validation: a failure comes back as `INVALID_PARAMS` with `details.issues`. One of its consequences says this "is also the split the MCP SDK itself enforces, so a schema-shaped rejection reads the same whichever layer produced it". That was wrong. `McpServer.registerTool` (SDK 1.29) installs a `tools/call` handler that parses the arguments against the advertised `spec.inputSchema` before our handler runs. A failure there becomes an `isError` result whose only content is the text `MCP error -32602: Input validation error: …` with zod's issue dump. So no real client ever saw the gate's envelope. The gate's formatting, such as flattening a failed union so the message names an object item's bad key, reached only tests and in-process callers, because the tests call the registration's handler directly. The SDK uses the same schema both to advertise and to validate, so no schema we pass can advertise the full contract and also leave validation to the gate.

## Decision

`startNeuroVaultServer` still registers every tool with `McpServer.registerTool`, so `tools/list` stays the SDK's own. Once they are registered, `dispatchToolCallsToGate` (`src/lib/tool-dispatch.ts`) replaces the SDK's `tools/call` handler on the underlying `Server` with one that passes `params.arguments` unchanged to the registration's handler. The gate coerces, validates and reports the arguments. An unknown tool is answered with the SDK's own text, word for word.

## Consequences

- A client gets the `INVALID_PARAMS` envelope that ADR-0015 and the specs describe, for every tool, including tools added later.
- The advertised input schemas are unchanged, byte for byte: they still come from the SDK's conversion of the coercing schema.
- Coercion still runs once, in the gate. Before, a valid call was parsed twice, once by the SDK and once by the gate.
- We now own the parts of the SDK's handler that applied to us: looking up the tool by name, and the unknown-tool answer. The parts that did not apply are gone: output-schema validation, disabled tools and task execution. A tool that declares an `outputSchema`, or one that runs as a task, has to bring them back here.
- The replacement depends on two SDK behaviours: `setRequestHandler` overwrites a handler, and `McpServer` installs its own handler only once, on the first `registerTool`. `test/tool-gate-over-wire.test.ts` boots the real server with an SDK `Client` over an in-memory transport, so an SDK upgrade that breaks either behaviour fails the suite.

## Alternatives considered

- **Hand the SDK a permissive schema and advertise the real one through zod `.meta()`**: the JSON Schema would no longer come from the schema that validates, and `required` and `additionalProperties` would need patching by hand.
- **Write both `tools/list` and `tools/call` on the low-level `Server`**: we would own the listing format too, for no gain.
- **Accept the SDK's error and fix the docs**: this discards `details.issues` and the gate's messages, which the specs require.
