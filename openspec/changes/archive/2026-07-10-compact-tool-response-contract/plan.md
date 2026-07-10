# Compact Tool Response Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Minify the success text channel and put the error code (+ details) into error text, in the single response choke point `src/lib/tool-response.ts`.

**Architecture:** All 16 tools funnel through `toToolResponse()` / `toToolErrorResponse()`; only those two functions change. Success text becomes `JSON.stringify(value)` (functionally equivalent to `structuredContent`, minified). `ToolHandlerError` text becomes `` `${code}: ${message}` `` plus a `details:` line when details exist. Error `structuredContent` (ADR-0003 contract) is untouched. See `design.md` (D1–D3) and `specs/tool-response-envelope/spec.md`.

**Tech Stack:** TypeScript (strict, ESM), vitest, eslint, tsup. Node ≥ 20.

## Global Constraints

- `npm test`, `npm run lint`, `npm run typecheck` must pass before any commit (repo rule; `npm run typecheck` is authoritative over a tsup build).
- Conventional Commits; work lands via PR to `main`, never a direct push.
- Error shape `{ code, message, details }` in `structuredContent` is contract (ADR-0003) — do not alter it.
- Commit trailer: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

---

### Task 1: Minify success text in `toToolResponse`

**Files:**
- Modify: `src/lib/tool-response.ts:62` (the `JSON.stringify(value, null, 2)` line)
- Test: `test/lib/tool-response.test.ts`
- Test: `test/lib/tool-registry.test.ts:88` (pretty-array assertion)

**Interfaces:**
- Consumes: existing `toToolResponse(value: unknown): CallToolResult`.
- Produces: same signature; `content[0].text` is now minified. Task 2 relies on this file's existing `toToolErrorResponse` staying adjacent.

- [ ] **Step 1: Rewrite the success-format tests to expect minified equivalence**

In `test/lib/tool-response.test.ts`, replace the `serializes objects as pretty JSON` test with:

```typescript
  it('serializes objects as minified JSON equal to structuredContent', () => {
    const result = toToolResponse({ path: 'a.md', nested: { n: 1 } });
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toBe('{"path":"a.md","nested":{"n":1}}');
    expect(block.text).toBe(JSON.stringify(result.structuredContent));
  });

  it('serializes arrays as minified JSON without structuredContent', () => {
    const result = toToolResponse([{ name: 'a' }]);
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toBe('[{"name":"a"}]');
    expect(result.structuredContent).toBeUndefined();
  });

  it('keeps the ok sentinel for void results', () => {
    const result = toToolResponse(undefined);
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toBe('ok');
    expect(result.structuredContent).toBeUndefined();
  });
```

Also update `test/lib/tool-registry.test.ts` line 88: change
`text: JSON.stringify([{ name: 'a' }, { name: 'b' }], null, 2)` to
`text: JSON.stringify([{ name: 'a' }, { name: 'b' }])`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib/tool-response.test.ts test/lib/tool-registry.test.ts`
Expected: FAIL — minified assertions get pretty output.

- [ ] **Step 3: Minify the serialization**

In `src/lib/tool-response.ts`, change:

```typescript
  const text = value === undefined ? 'ok' : JSON.stringify(value, null, 2);
```

to:

```typescript
  const text = value === undefined ? 'ok' : JSON.stringify(value);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/tool-response.test.ts test/lib/tool-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass (if another test asserts pretty text, update it to the minified form and rerun).

```bash
git add src/lib/tool-response.ts test/lib/tool-response.test.ts test/lib/tool-registry.test.ts
git commit -m "feat(mcp): emit minified JSON in tool response text channel

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Error text carries code and details

**Files:**
- Modify: `src/lib/tool-response.ts:72-91` (`toToolErrorResponse`)
- Test: `test/lib/tool-response.test.ts`

**Interfaces:**
- Consumes: existing `ToolHandlerError` (same file) and `toToolErrorResponse(error: unknown): CallToolResult`.
- Produces: same signature; for `ToolHandlerError`, `content[0].text` is `` `${code}: ${message}` `` and, when `details` is defined, `` `${code}: ${message}\ndetails: ${JSON.stringify(details)}` ``. `structuredContent` and `isError` unchanged.

- [ ] **Step 1: Write failing error-format tests**

Append to `test/lib/tool-response.test.ts` (import `toToolErrorResponse` and `ToolHandlerError` from `../../src/lib/tool-response.js`):

```typescript
describe('toToolErrorResponse', () => {
  it('prefixes ToolHandlerError text with the code', () => {
    const result = toToolErrorResponse(
      new ToolHandlerError('VAULT_NOT_FOUND', 'vault "x" is not registered'),
    );
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toBe('VAULT_NOT_FOUND: vault "x" is not registered');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: 'VAULT_NOT_FOUND',
      message: 'vault "x" is not registered',
      details: undefined,
    });
  });

  it('appends a details line when details are present', () => {
    const result = toToolErrorResponse(
      new ToolHandlerError('INVALID_FILTER', 'operator $bad is not allowed', {
        details: { field: 'filter' },
      }),
    );
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toBe(
      'INVALID_FILTER: operator $bad is not allowed\ndetails: {"field":"filter"}',
    );
  });

  it('keeps message-only text for non-handler errors', () => {
    const result = toToolErrorResponse(new Error('disk read failed'));
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toBe('disk read failed');
    expect(result.structuredContent).toEqual({ message: 'disk read failed' });
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify the new cases fail**

Run: `npx vitest run test/lib/tool-response.test.ts`
Expected: FAIL — text lacks the `CODE: ` prefix.

- [ ] **Step 3: Implement the error text format**

In `src/lib/tool-response.ts`, inside the `error instanceof ToolHandlerError` branch of `toToolErrorResponse`, build the text before the return:

```typescript
  if (error instanceof ToolHandlerError) {
    const text =
      error.details !== undefined
        ? `${error.code}: ${error.message}\ndetails: ${JSON.stringify(error.details)}`
        : `${error.code}: ${error.message}`;
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
      isError: true,
    };
  }
```

The non-handler branch stays exactly as it is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib/tool-response.test.ts`
Expected: PASS.

- [ ] **Step 5: Sweep other tests asserting error text, run full gates, commit**

Run: `npm test`
Expected: any test asserting a bare error message in `content[0].text` fails; update those assertions to the `CODE: message` format (known candidates: `test/lib/tool-registry.test.ts`, `test/server-modules.test.ts`, `test/lib/obsidian/vault-writer.test.ts` — most assert `structuredContent`, which is unchanged). Then:

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass.

```bash
git add src/lib/tool-response.ts test/
git commit -m "feat(mcp): include error code and details in error text channel

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Architecture living doc

**Files:**
- Create: `docs/architecture/tool-response-envelope.md`
- Modify: `docs/architecture/README.md` (only if it indexes files — check first)

**Interfaces:**
- Consumes: final behavior from Tasks 1–2.
- Produces: living doc other contributors read before touching the envelope.

- [ ] **Step 1: Write the doc**

Create `docs/architecture/tool-response-envelope.md` following the style of sibling docs (e.g., `error-mapping-cli.md` — current-state mechanism, no history). Cover: the single choke point (`toToolResponse` / `toToolErrorResponse` via `invokeTool`); success policy (minified text, `structuredContent` only for plain objects, `text === JSON.stringify(structuredContent)`, void → `ok`); error policy (`CODE: message` + optional `details:` line; structured `{ code, message, details }` per ADR-0003); and the client-behavior rationale (Claude Code injects `structuredContent` for success but only text for errors — measured 2026-07-10; a summary-only text would violate the MCP spec's functional-equivalence SHOULD).

- [ ] **Step 2: Link from the index if one exists**

Check `docs/architecture/README.md`; if it lists files, add a one-line entry for `tool-response-envelope.md` in its style.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/
git commit -m "docs(architecture): document tool response envelope policy

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: End-to-end verification

**Files:**
- No new files (throwaway probe script may live in the scratchpad, not the repo).

**Interfaces:**
- Consumes: the built server (`npm run build` → `dist/cli.js`).

- [ ] **Step 1: Full gates**

Run: `npm test && npm run lint && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 2: Raw JSON-RPC smoke check against the built server**

Pipe three JSON-RPC lines (initialize → initialized → `tools/call`) into `node dist/cli.js --vault <vault>`:

```bash
{ printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.1"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query_notes","arguments":{"filter":{"frontmatter.type":"task"},"limit":5}}}' \
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"query_notes","arguments":{"filter":{"frontmatter.type":{"$bad":1}}}}}' ; sleep 4; } \
| node dist/cli.js --vault /Users/amostovenko/Obsidian 2>/dev/null > /tmp/probe.jsonl
node -e "
const lines = require('fs').readFileSync('/tmp/probe.jsonl','utf8').trim().split('\n').map(JSON.parse);
const ok = lines.find(l => l.id === 2).result;
const err = lines.find(l => l.id === 3).result;
console.log('success text === minified structured:', ok.content[0].text === JSON.stringify(ok.structuredContent));
console.log('error text:', err.content[0].text.split('\n')[0]);
"
```

Expected output: `success text === minified structured: true` and an error text starting with `INVALID_FILTER: `.

- [ ] **Step 3: Verify no uncommitted changes remain**

Run: `git status --short`
Expected: clean (all work committed in Tasks 1–3).
