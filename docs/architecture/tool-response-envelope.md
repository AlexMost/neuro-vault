# Tool Response Envelope

How every MCP tool result — success or error — is shaped into a `CallToolResult` at a single choke point, and why the text and structured channels carry the payloads they do.

## What it is

`src/lib/tool-response.ts` exports two pure functions, `toToolResponse(value)` and `toToolErrorResponse(error)`, plus `invokeTool(handler)`, which calls the handler and routes its outcome through one of the two. `registerTool` in `src/lib/tool-registry.ts` wraps every tool's `handler` in `invokeTool(...)` at registration time — there is no other path from a tool handler to the wire. A handler returns a plain value or throws; it never builds a `CallToolResult` itself.

```
registerTool(tool)
  │
  ▼
handler: (args) => invokeTool(() => tool.handler(parsedArgs))
  │
  ├─ resolves → toToolResponse(value)
  └─ rejects  → toToolErrorResponse(error)
```

## Success policy

`toToolResponse(value)`:

- `content[0].text` is `JSON.stringify(value)` — minified, no pretty-printing. If `value` is `undefined` (a void handler), the text is the literal string `ok`.
- `structuredContent` is set to `value` only when `value` is a **plain object** (`typeof === 'object'`, not `null`, not an array, prototype is `Object.prototype`). Arrays and primitives are returned as text only — the MCP SDK's `structuredContent` field is documented for object results, so non-object values skip it rather than being wrapped or coerced.
- When `structuredContent` is set, `text` and `structuredContent` serialize the same data — `text === JSON.stringify(structuredContent)`. There is no separate summarization step; the text channel is a full, minified mirror of the structured one.

## Error policy

`toToolErrorResponse(error)`:

- For a `ToolHandlerError` (the domain error type behind [ADR-0003](../adr/0003-structured-errors-toolhandlererror.md)): `content[0].text` is `` `${code}: ${message}` ``. When `error.details` is present, a second line is appended: `` `\ndetails: ${JSON.stringify(details)}` ``. `structuredContent` is always `{ code, message, details }`, unchanged by whether details ended up in the text.
- For any other thrown value: `content[0].text` is the bare message (`error.message`, or `'Unknown tool error'` if it isn't even an `Error`); `structuredContent` is `{ message }`. There is no code to prefix because non-`ToolHandlerError` failures are not classified.
- Both branches set `isError: true`.

`invokeTool` is also the only place `ToolHandlerError` is caught for the response boundary — `registerTool` throws a fresh `ToolHandlerError('INVALID_PARAMS', ...)` on zod validation failure (see [input-coercion.md](./input-coercion.md)), and that error flows through the same `toToolErrorResponse` as every domain error a handler throws.

## Client-behavior rationale

The policy above is shaped by one measured fact about the primary client, Claude Code (2026-07-10): it injects `structuredContent` into the model's context for successful tool calls, but for error results it injects only `content[0].text` — `structuredContent` on an error is invisible to the agent. Two consequences follow directly:

- **The error code must live in the text, not just `structuredContent`.** If `code` only appeared in the structured payload, the agent would see a bare message with no ADR-0003 code to branch on — exactly the bug this contract fixes. Prefixing `code:` onto `content[0].text` is the only way to guarantee the agent can read it, regardless of client.
- **Success text stays a full minified serialization, not a summary.** Because Claude Code already gets the full payload via `structuredContent` for success, a hand-written summary in `text` would save it zero tokens — the savings would only apply to text-only clients, at the cost of losing data for them. The MCP spec's SHOULD that `content` text be functionally equivalent to `structuredContent` points the same direction: `text` remains a complete, if minified, serialization so that a text-only client sees the same information a structured-aware client sees. Minifying (dropping the `null, 2` pretty-print) was still worth doing — pretty-printing added +57% to the text channel and made the full wire result 2.79× the size of one minified copy — but the fix is disciplined whitespace removal, not truncation or summarization.

## Boundaries

- `tool-response.ts` has no knowledge of any specific tool's payload shape. It only inspects `value`'s runtime type (object vs. array vs. primitive vs. `undefined`) and whether an error is a `ToolHandlerError`.
- It does not decide *what* error code or message to use — that is each handler's responsibility (see [error-mapping-cli.md](./error-mapping-cli.md) for one source of codes). It only decides how a given `{ code, message, details }` is rendered into `content`/`structuredContent`.
- No per-tool override exists. A tool that wanted a different envelope shape would need a change here, not a local one — the same "single choke point" discipline `input-coercion.md` and `mcp-server-shape.md` describe for their own concerns.
