# `read_notes.paths`: accept `string` or `string[]`

Status: design
Date: 2026-04-28
Supersedes: —

## Problem

`read_notes` declares `paths: string[]`. The schema is logical — a batch tool taking a batch — but in practice callers (LLMs, scripts, ad-hoc clients) routinely pass a single string when they want a single note:

```jsonc
{ "paths": "Projects/neuro-vault.md" }
// → "expected array, received string"
```

Observed live in the 2026-04-28 session: the model hit this twice in a row and silently fell back to the host's native `Read` instead of using the vault tool. Strict schemas at the boundary push callers off the tool entirely — the cost of the rejection is not "one retry", it's lost adoption.

The lenient-input-coercion layer added in 3.2.0 (`src/lib/input-coercion.ts`) deliberately does not coerce string-to-array (see the 2026-04-28-mcp-input-coercion spec, "Non-goals"). Solving this case has to happen at the schema, not the dispatcher.

## Goal

Accept either a single `string` or a `string[]` of 1–50 paths for `read_notes.paths`. Normalise to an array inside the handler so downstream code (dedup, per-item validation, reader call, projection) is unchanged.

## Non-goals

- Do not change other tools that take a single `path: string` (`get_similar_notes`, `read_property`, `set_property`, `remove_property`, `create_note`, `edit_note`). Their semantics are "one note", not "a batch of one"; a union there only confuses callers.
- Do not extend `read_notes.fields` to accept a single string. Different concept, no observed friction.
- Do not change the wire-level coercion module — this stays a per-tool schema decision.

## Decision

### Schema

```ts
const pathsSchema = z.union([z.string().min(1), z.array(z.string()).min(1).max(50)]);
```

`z.string().min(1)` rejects the empty string at the schema layer (matches the existing per-item normalisation contract). The array variant keeps the existing 1–50 bound.

### Handler

The handler normalises before any other work:

```ts
const rawPaths = Array.isArray(input.paths) ? input.paths : [input.paths];
```

Everything after that — `validateReadNotesInput`, dedup, `normalizePath`, reader call, projection — continues to operate on `string[]` exactly as today.

### Type

`ReadNotesToolInput.paths` becomes `string | string[]`. `validateReadNotesInput` returns the normalised array. The reader's `ReadNotesInput.paths` stays `string[]` — the union is a tool-boundary concern only.

### Description

Update the tool description to advertise the relaxation, otherwise an LLM that learned the strict shape will keep wrapping single paths into one-element arrays:

> `paths` is a vault-relative POSIX path or an array of 1–50 such paths.

Same edit in `docs/guide/vault-operations.md` and the relevant lines of `src/server.ts` (SERVER_INSTRUCTIONS).

## Tests

Added to `test/operations/tools/read-notes.test.ts`:

- `paths: "a.md"` → array with one result, identical to passing `["a.md"]`.
- `paths: ""` → INVALID_ARGUMENT (zod rejects empty string at the schema layer; surfaced via the dispatcher's `INVALID_PARAMS` mapping).
- Existing array cases (`[]` rejected, 51 entries rejected, 1–50 accepted) continue to pass — regression guard.

## Release

- Single Conventional Commit: `feat(operations): accept string or string[] for read_notes.paths`. Minor bump (additive — strict callers unchanged).
- README has no `read_notes` shape docs to update; the user-facing surface is `docs/guide/vault-operations.md` and the `SERVER_INSTRUCTIONS` block in `src/server.ts`.
- Release flow per AGENTS.md: PR → merge to `main` → `npm run release` on `main`.

## Definition of Done

- Schema, type, helper, handler, description, and guide all updated together.
- Single-string and array-of-strings calls both succeed with identical results.
- `npm test`, `npm run lint`, `npx tsc --noEmit` all green.
