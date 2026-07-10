## Context

All 16 MCP tools funnel their results through two functions in `src/lib/tool-response.ts`: `toToolResponse()` (success) and `toToolErrorResponse()` (errors), invoked via `invokeTool()` from the registry. Success responses duplicate the payload — pretty JSON in `content[0].text` and the same object in `structuredContent` (2.79× wire overhead measured on a representative `query_notes` response). Error responses put `code`/`details` only into `structuredContent`, which the primary client (Claude Code) drops for errors — measured empirically in the explore session: the agent sees only the bare message text, never the ADR-0003 error code.

Constraints: ADR-0003 (structured errors — the `{ code, message, details }` shape is contract), the MCP spec SHOULD ("text functionally equivalent to structuredContent"), and the vault task's quality criteria (no data loss for any client class, deterministic behavior, no heuristic truncation).

## Goals / Non-Goals

**Goals:**

- One deterministic envelope policy at the single choke point; no tool-specific formats.
- Success: text remains functionally equivalent to `structuredContent`, minified.
- Errors: the agent can read `code` (and `details` when present) from `content[0].text` alone.
- Regression coverage for both formats.

**Non-Goals:**

- No `outputSchema` adoption (deferred follow-up, P3 in the vault task).
- No summary-text or response-mode configuration (rejected in brainstorm Q2/Q3).
- No change to success `structuredContent` logic, tool result shapes, retrieval policy, or `undefined → 'ok'` void handling.

## Decisions

### D1: Minify success text instead of summarizing or dropping it

- **Choice**: `JSON.stringify(value)` replaces `JSON.stringify(value, null, 2)` in `toToolResponse()`.
- **Rationale**: keeps the spec-recommended functional equivalence and full data for text-only clients; removes the entire pretty-print overhead (+57% of text, ~2.0× → from 2.79× wire). Agents parse minified JSON identically.
- **Alternatives considered**: summary text (variant A) — rejected: saves zero context tokens in Claude Code (which injects `structuredContent` for success), loses data on text-only clients, violates the spec SHOULD. Dropping `structuredContent` (variant B) — rejected: loses the native structured channel the primary client actually uses. Response-mode config (variant C) — rejected: permanent public-API surface with no demonstrated need after minification.

### D2: Error text format is `CODE: message` + optional details line

- **Choice**: for `ToolHandlerError`, `content[0].text` becomes `` `${code}: ${message}` ``; when `details` is present, append `\ndetails: ${JSON.stringify(details)}`. Non-`ToolHandlerError` errors keep message-only text (they have no code). Error `structuredContent` unchanged.
- **Rationale**: the text channel is the only one the agent reliably sees for errors; the code prefix makes error classes machine-distinguishable (e.g., permission rejections vs. real tool errors). A call-site survey shows every `details` object is small and bounded (paths, field names, registered-vault lists, zod issues), so inlining is safe.
- **Alternatives considered**: details only in `structuredContent` — rejected: invisible to the agent (the very bug being fixed). Per-code heuristics for when to include details (e.g., skip `INVALID_PARAMS` whose message already joins the zod issues) — rejected: the vault task's quality criteria demand deterministic, heuristic-free behavior; the minor duplication is accepted.

### D3: Single choke point, no per-tool changes

- **Choice**: only `src/lib/tool-response.ts` changes; all tools inherit.
- **Rationale**: the envelope is one concept; per-tool formatting would violate the "predictable across tools" quality criterion.
- **Alternatives considered**: none seriously — the choke point already exists.

## Risks / Trade-offs

- [Risk] A client or user script asserts on pretty-printed text or exact error message text → Mitigation: minor-version release with a changelog entry describing both format changes; the structured error shape (the actual ADR-0003 contract) is untouched.
- [Risk] Some `details` object grows large in the future and bloats error text → Mitigation: acceptable today (survey shows bounded shapes); if a future tool needs large details, that is a contract decision for that tool's change, not a heuristic here.
- [Trade-off] `INVALID_PARAMS` error text duplicates zod issue info (message already joins issues, details repeats them structured) → accepted for one deterministic rule over special cases.
- [Trade-off] Residual wire duplication (~2.0×: minified text + structuredContent) remains → accepted: spec-recommended equivalence; no real client demonstrated to be harmed; stdio transport makes wire bytes near-free.

## Migration Plan

N/A — no deployment, endpoint, or storage changes. Ships as a normal minor release (`feat`): PR to `main`, then `npm run release` on `main`. Rollback = revert the PR. Acceptance: `npm test && npm run lint && npm run typecheck && npm run build` pass; envelope tests assert minified equivalence and the error text format.

## Open Questions

None — all forks were resolved in the brainstorm (Q1–Q6).
