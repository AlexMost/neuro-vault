<!--
Raw capture of the explore-mode brainstorm (session 2026-07-10) that converged
on this change. Source task: Obsidian vault
`Tasks/neuro-vault/Якісний і компактний контракт MCP-відповідей.md`.
-->

# Brainstorm — compact tool response contract (P1 + P2)

## Background

The vault task asked to review the success-response contract: `toToolResponse()`
(`src/lib/tool-response.ts`) returns the same payload twice — pretty-printed
JSON in `content[0].text` and the same object in `structuredContent`. Suspected
cost: bloated tool output and truncation. Four candidate directions were listed
in the task (A: summary text, B: content-only, C: response mode config,
D: minified text only).

## Empirical findings (explore session, live server v12.1.0)

1. **Claude Code success path**: the model receives ONE minified serialization
   of `structuredContent`. The pretty text block never reaches model context
   (observed: server emits pretty text, model context shows minified JSON).
2. **Claude Code error path** (controlled experiment — `query_notes` with
   `$badOperator`): the model receives ONLY `content[0].text`. The structured
   error `{ code, message, details }` is dropped entirely — error `code` and
   `details` are invisible to the agent, despite ADR-0003 existing so clients
   can branch on `code`.
3. **Wire measurement** (raw JSON-RPC probe, `query_notes`, 50 task notes):
   minified payload 11,773 B; pretty text 18,467 B (+57%); full
   `CallToolResult` on the wire 32,852 B = **2.79×** a single minified copy
   (pretty-print + JSON-string escaping + duplication).
4. **SDK 1.29.0**: declaring `outputSchema` makes `structuredContent` required
   and validated; the SDK does NOT auto-generate or require a text fallback.
   No tool currently declares `outputSchema`.
5. **MCP spec (2025-06-18)**: when `structuredContent` is present, text SHOULD
   be *functionally equivalent* serialized JSON. A summary-only text (variant A)
   violates this SHOULD.

## Decision chain

**Q1 — Is context-token duplication real?** No, not in Claude Code (primary
client): the model already sees a single minified copy. Duplication costs wire
bytes only (stdio, near-free locally). The observed truncation came from
genuinely large single-copy payloads — a shape/paging concern, explicitly out
of scope in the vault task.

**Q2 — Variant A (summary text) as default?** Rejected. It saves zero context
tokens in Claude Code, destroys data for text-only clients (violates quality
criterion #1 "agent always gets enough data"), and violates the spec SHOULD.

**Q3 — Variant C (response mode config)?** Rejected. MCP has no capability
negotiation for this; a config axis is public API forever; after minification
the residual wire duplication has no demonstrated harm to any real client.

**Q4 — What ships?** User approved scope: **P1 + P2** only.

- **P1 — minify the text channel** (variant D as the floor):
  `JSON.stringify(value)` instead of `JSON.stringify(value, null, 2)` in
  `toToolResponse()`. Wire 2.79× → ~2.0×; text-only clients save ~36% tokens;
  spec equivalence (`text === JSON.stringify(structuredContent)`) preserved.
- **P2 — carry the error code (and details) in error text**: since structured
  error content never reaches the agent in Claude Code, `toToolErrorResponse()`
  must put the code into text.

**Q5 — P2 exact text format?** Deterministic, no heuristics:

- `ToolHandlerError` → `` `${code}: ${message}` ``; when `details` is present,
  append a second line `` `details: ${JSON.stringify(details)}` ``.
  Survey of all `ToolHandlerError` call sites shows `details` are small bounded
  objects (paths, field names, registered-vault lists, zod issues) — safe to
  inline. Known minor duplication: `INVALID_PARAMS` message already joins the
  zod issues; accepted for the sake of a single deterministic rule.
- Non-`ToolHandlerError` → unchanged (message only; there is no code).
- `structuredContent` for errors stays exactly as today (ADR-0003 shape).

**Q6 — Anything else touched?** No. `undefined → 'ok'` stays; success
`structuredContent` logic (plain records only) stays; no `outputSchema` work
(that was P3, deferred); no response-mode config (P4 rejected); no shape or
retrieval changes (out of scope per the vault task).

## Acceptance

- `text === JSON.stringify(structuredContent)` for success responses with
  structured content (minified equivalence).
- Every `ToolHandlerError` response carries its `code` at the start of
  `content[0].text`; `details`, when present, appear in the text.
- Existing tests updated (`test/lib/tool-response.test.ts` asserts pretty JSON
  today); new tests for error text format (with/without details, non-handler
  errors).
- `npm test && npm run lint && npm run typecheck && npm run build` pass.

## Follow-ups explicitly deferred (recorded in the vault task)

- P3: selective `outputSchema` adoption (needs `{ok: true}` normalization for
  void tools first — SDK throws if schema declared without structuredContent).
- Repeatable JSON-RPC probe script + Codex CLI verification of channel
  consumption.
