# ADR-0013 — The server builds and owns its embedding corpus

- **Status**: Accepted
- **Date**: 2026-08-25

## Context

[ADR-0006](0006-smart-connections-corpus.md) rested on one premise: embeddings come free from a plugin the user already runs, and generating them ourselves would cost a model, an indexing pass, keys and a background process. Three of those four costs are gone.

- The model is already loaded. The query side embeds every search string with `bge-micro-v2` through transformers.js — there is no key, no service, and no second model to add.
- Indexing was measured, not estimated: a full cold index of an 842-note vault takes **~2.3 min** and **~90 ms per changed note** on a current laptop; a no-op reconcile over the same vault is **0.09 s**. "Too expensive to own" is no longer true at vault scale.
- The inherited corpus is not fresh and cannot be reconciled with the rest of the server. The live plugin corpus held 1075 source records against 866 real notes, last written a month before it was measured, and its membership is decided by the plugin's own exclusion quirks — so a note the vault scope hides can still surface under `semantic_matches` while being absent from every lexical surface ([`vault-scope`](../architecture/vault-scope.md)).

What remains is the distribution constraint: this package installs via `npx`, so a store that compiles on install or ships a 200 MB platform binary is not an option.

## Decision

The server builds and owns an embedding corpus. It derives embed inputs from note text, embeds them with the model it already loads, and writes the result under **`<vault>/.neuro-vault/corpus/`** — one self-describing JSON shard per note plus a small manifest, every write atomic, membership taken from the vault scope, freshness maintained by an incremental reconcile keyed on content hash. The mechanism is documented in [`docs/architecture/own-corpus.md`](../architecture/own-corpus.md).

This **supersedes the "the server never writes embeddings" half of ADR-0006**. The read-only consumption of the Smart Connections corpus stands as history and still serves every semantic tool until the backend-integration slice switches over.

## Consequences

- The server acquires a write path inside the user's vault. It is confined to a dot-directory the scope always excludes; the only write outside it is a single best-effort `.neuro-vault/corpus/` line appended to the vault's root `.gitignore`, which warns on failure and never fails indexing.
- One new runtime dependency, `write-file-atomic` (ISC, pure JS). No native dependency, no change to the Node floor.
- Corpus freshness becomes ours to maintain rather than the plugin's to neglect — and corpus membership becomes the same set the lexical leg sees.
- Extraction reproduces the replaced corpus 1:1 on purpose, so the one diagnostic run that compares the two backends is interpretable. Every improvement to embed text — starting with a note vector built from its block vectors rather than the first 1894 characters — lands behind an `embed_version` bump, which discards the corpus and rebuilds it. That pair, `embed_version` plus full rebuild, is the migration lever for every future change to how text becomes vectors, including a change of model.
- A vector is a function of `(path, content, strategy)`, because both embed-text formulas carry path breadcrumbs. Renaming a note therefore re-embeds it; the payoff is that a corpus maintained incrementally is byte-identical to one built from scratch.
- The corpus format is one-way — only our loader reads it — which is what allows dropping the plugin's vector-less block records (two thirds of its entries) and its append log entirely.

## Alternatives considered

- **The plugin's AJSON format** — an append log needing replay, compaction and tombstones, whose crash story is weaker than a plain temp-file-plus-rename, and whose vectors as JSON numbers are 3.8× larger than base64 float32; compatibility with the plugin buys nothing once we write the corpus ourselves.
- **LanceDB** — a 155–227 MB platform binary per cold `npx` cache, and no darwin-x64 prebuild at all: on an Intel Mac the install succeeds and the runtime fails.
- **hnswlib-node** — `node-gyp rebuild` on every install with no prebuilds, and `saveIndex` writes over the only copy of the index; ANN buys nothing against a brute-force scan of ~15k vectors.
- **SQLite, either way** — `better-sqlite3` v13 finally bundles prebuilds, and the built-in `node:sqlite` needs no dependency at all, but both require Node ≥ 22 against our floor of 20. This is the documented successor once the floor moves.
