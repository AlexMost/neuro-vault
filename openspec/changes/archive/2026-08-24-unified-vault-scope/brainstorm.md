# Brainstorm — unified-vault-scope

Raw capture. Format: background → decision chain → trade-offs.

**Provenance note.** The brainstorming for this change did not happen in this
session. It happened inside the wayfinder effort "Власний embedding pipeline"
(`.scratch/own-embedding-pipeline/`, label `wayfinder:map`), as grilling
sessions with the user, resolved 2026-08-23:

- [`issues/04-exclusion-semantics.md`](../../../.scratch/own-embedding-pipeline/issues/04-exclusion-semantics.md)
  — the design decisions this change implements (9-point resolution).
- [`issues/09-final-task-slicing.md`](../../../.scratch/own-embedding-pipeline/issues/09-final-task-slicing.md)
  — the slicing decision that makes this slice #1 of a six-change queue.

This file transcribes those decisions so the change is self-contained; it does
not re-open them. The user's instruction was explicit: "беремо
unified-vault-scope із wayfinder артефактів".

## Background

neuro-vault is migrating off the Smart Connections embedding corpus to its own
indexer (the wayfinder map's destination). Today "which vault files are
visible" has two independent answers:

- The **lexical leg** (`vault-reader.scan`) walks the vault itself with its own
  glob/dot-file rules.
- The **semantic leg** inherits whatever Smart Connections chose to embed,
  including SC's own `file_exclusions`/`folder_exclusions` config inside
  `.smart-env`.

When the server starts writing its own corpus (queue slice #2,
`own-corpus-indexer`), the indexer needs an exclusion answer too — and if it
got a third independent one, the two search legs of `search_notes` would
disagree about membership, producing weird `found_in` combinations (a note
lexically visible but semantically invisible, or vice versa, with no
principled reason).

Slice #1 therefore builds the shared answer first: one **scope module** that
both the lexical scan and the (future) semantic indexer consult. It contains
no embedding code, so it is self-contained and can ship before any indexer
work. It also establishes the `.neuro-vault/` per-vault directory convention
that later slices (corpus storage, eval golden set) build on.

## Decision chain

Numbering follows the resolution points of ticket 04 (grilling with the user,
resolved 2026-08-23).

### Q1 — One scope or per-leg scopes?

**Decision: a single scope for both legs.** One definition of "visible vault
files" — a shared scope module read by the lexical scan (`vault-reader.scan`)
and by the semantic indexer. Embedding-specific rules (`min_chars: 200`,
embed-text truncation) are index-side only and do NOT belong to the scope:
the scope says *which files*, the index says *what part of a file*.

Rejected alternative: separate lexical/semantic exclusion configs. That is the
status quo failure mode — divergent membership shows up as inexplicable
`found_in` values in `search_notes`.

### Q2 — What is always excluded?

**Decision: dotfiles and dot-directories, unconditionally and
non-configurably.** `.obsidian`, `.smart-env`, `.git`, `.neuro-vault`,
`.trash`, … — consistent with the lexical leg's current `dot: false`
behaviour. This also auto-excludes the future golden-set home
(`.neuro-vault/eval/`, per ticket 08) with no extra rule.

### Q3 — Built-in defaults beyond dot-paths?

**Decision: `Templates/` plus the entries of the vault's root `.gitignore`.**
Both are defaults, not hardcoded constants — they combine with user config by
union (Q5).

### Q4 — How much gitignore semantics?

**Decision: root `.gitignore` only, minimal semantics.** Lines are treated as
exclusion globs; negation lines (`!...`) are ignored; nested `.gitignore`
files are not supported.

Accepted side effect (deliberate behaviour change): `docs/superpowers/` — the
only non-dot entry in the live vault's root `.gitignore` — disappears from
**lexical** search too. SC already excludes it from the semantic corpus, so
this restores parity between the legs rather than breaking it.

### Q5 — Where does user config live and how does it combine?

**Decision: `.neuro-vault/config.json` per vault, key `"exclusions": [...]`.**
Semantics: **union** with the defaults. No negation/override mechanism
(YAGNI — nobody has asked to re-include `Templates/`). The CLI surface does
not change.

### Q6 — Pattern semantics?

**Decision: standard globs anchored at the vault root**, evaluated with
fast-glob/picomatch (already a dependency). SC's quirky semantics
(`file**`-style implicit prefixing) are deliberately NOT reproduced. The one
known membership diff vs the live SC corpus is `Untitled.md` in the vault
root (SC's `file_exclusions: "Untitled"`); it is to be noted during the
parity diff (slice #5/#6 territory), not handled here.

### Q7 — What happens when exclusion config changes?

**Decision: a scope change is a membership change, not a vector change.** For
the future corpus it means an ordinary incremental reconcile on the next pass
(out-of-scope vectors dropped, newly in-scope notes embedded) — no full
re-embed, no `embed_version` bump. In this slice, with no corpus yet, the
practical meaning is simply: the next scan reflects the current config.

### Q8 — `excluded_headings`?

**Decision: not implemented.** Empty in the live SC config, unused feature.
If ever needed, it is a separate step with an `embed_version` bump (it changes
embed-text, not membership).

### Q9 — Is scope an ACL?

**Decision: no — scope is discovery, not access control.** It governs
scan/search/query/indexing. `read_notes` with an explicit path still reads
excluded files (templates, golden set — legitimate direct reads).

## Slicing decisions (ticket 09, as they bind this change)

- This slice is **#1 of six** and self-contained: no embedding code, no
  dependency on any other slice. `own-corpus-indexer` (#2) depends on it.
- `vault-reader.scan` moves onto the scope module — the lexical leg is the
  in-repo consumer that proves the module in this slice.
- The slice establishes the `.neuro-vault/` per-vault convention (config now;
  corpus and eval directories in later slices).
- Routing: capability change (new config contract, shared module with
  ADR-level reach) → full opsx cycle, one PR, not a direct PR.

## Trade-offs accepted

- **Union-only config** trades expressiveness for predictability: users cannot
  re-include a default-excluded path. Revisit only on real demand.
- **Root-only gitignore with no negation** is a deliberately tiny subset of
  git semantics — enough for the observed vault, cheap to reason about. Full
  gitignore semantics (nested files, negation, ordering) would import a large
  behaviour surface for zero present users.
- **Behaviour change in lexical search** (`docs/superpowers/` vanishing) is
  accepted and documented rather than gated behind config, because it aligns
  the legs — the whole point of the module.
- **`Untitled.md` diff vs SC** is accepted: reproducing SC's quirk semantics
  would leak SC's config format into the new world the effort is deleting.
