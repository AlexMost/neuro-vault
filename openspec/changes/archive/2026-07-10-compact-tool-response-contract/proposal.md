## Why

Tool responses today serialize the same payload twice: pretty-printed JSON in `content[0].text` plus the identical object in `structuredContent` — a measured 2.79× wire overhead over a single minified copy, and ~36% wasted tokens on clients that inject the text channel into model context. Worse, error responses are the inverse problem: Claude Code (the primary client) surfaces only `content[0].text` for errors, so the structured `{ code, details }` from ADR-0003 never reaches the agent — error codes exist precisely so agents can branch on them, and today they are invisible.

## What Changes

**Success text serialization**

- From: `content[0].text` is `JSON.stringify(value, null, 2)` (pretty-printed).
- To: `content[0].text` is `JSON.stringify(value)` (minified); still functionally equivalent to `structuredContent` per the MCP spec SHOULD.
- Reason: pretty-print adds +57% to the text channel and ~2.79× total wire size, with zero benefit — agents parse minified JSON identically.
- Impact: non-breaking for agents; any consumer asserting on pretty text formatting (tests) must update.

**Error text carries the code and details**

- From: `content[0].text` for a `ToolHandlerError` is `error.message` only; `code` and `details` live solely in `structuredContent`, which the primary client drops for errors.
- To: text is `` `${code}: ${message}` ``, plus a second line `` `details: ${JSON.stringify(details)}` `` when `details` is present. Error `structuredContent` is unchanged.
- Reason: the agent must be able to classify errors (e.g., distinguish `INVALID_FILTER` from `VAULT_NOT_FOUND`) from the only channel it reliably sees.
- Impact: non-breaking additive prefix; clients parsing exact error text must tolerate the `CODE: ` prefix.

Out of scope (deliberately): `outputSchema` adoption, summary-text mode, response-mode configuration, any change to success `structuredContent` logic or tool result shapes.

## Capabilities

### New Capabilities

- `tool-response-envelope`: the contract for how every tool result is packaged — success text/structuredContent equivalence and minification, void handling, and the error text format (code + message + details).

### Modified Capabilities

<!-- none — no existing spec covers the response envelope -->

## Impact

- Code: `src/lib/tool-response.ts` (`toToolResponse`, `toToolErrorResponse`); no tool handlers change.
- Tests: `test/lib/tool-response.test.ts` (pretty-JSON assertion), new error-format cases; any envelope assertions in `test/lib/tool-registry.test.ts`.
- Docs: architecture living docs entry for the response envelope; changelog via conventional commit (minor release).
- Systems: all 16 MCP tools inherit the new envelope automatically (single choke point).
