## 1. Success envelope — minified text (TDD)

- [ ] 1.1 Update `test/lib/tool-response.test.ts`: replace the pretty-JSON assertion with minified equivalence (`text === JSON.stringify(structuredContent)`, no indentation), and add cases for a non-plain-object payload (array → text only, no `structuredContent`) and the void `ok` sentinel; run and watch the pretty-JSON case fail
- [ ] 1.2 Change `toToolResponse()` in `src/lib/tool-response.ts` to `JSON.stringify(value)`; tests from 1.1 pass

## 2. Error envelope — code and details in text (TDD)

- [ ] 2.1 Add failing tests for `toToolErrorResponse()`: `ToolHandlerError` without details → text `CODE: message`; with details → second line `details: <minified JSON>`; `structuredContent` and `isError` unchanged; plain `Error` → message-only text
- [ ] 2.2 Implement the error text format in `toToolErrorResponse()`; tests from 2.1 pass
- [ ] 2.3 Sweep existing tests that assert on error text (e.g., `test/lib/tool-registry.test.ts`, tool tests asserting `content[0].text` of errors) and update them to the `CODE: message` format

## 3. Docs

- [ ] 3.1 Add `docs/architecture/tool-response-envelope.md` (living doc): the two-channel policy, minified equivalence, error text format, and the empirical client-behavior findings that motivated it; link it from `docs/architecture/README.md` if the README indexes files

## 4. Verification

- [ ] 4.1 Run `npm test && npm run lint && npm run typecheck && npm run build` — all pass
- [ ] 4.2 Smoke-check the built server over raw JSON-RPC stdio (initialize → `tools/call` `query_notes`, plus one call with an invalid filter): success text is minified and equal to serialized `structuredContent`; error text starts with `INVALID_FILTER: `
