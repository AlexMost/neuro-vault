# vault-scope Specification

## Purpose
TBD - created by archiving change unified-vault-scope. Update Purpose after archive.
## Requirements
### Requirement: One scope definition governs vault discovery

Each vault entry SHALL own exactly one scope object that decides which vault files are visible, and every discovery surface — the vault scan and everything derived from it (lexical search, `query_notes`, path listing, tag and property aggregation, vault overview, the wikilink graph, note-name resolution) as well as membership of the server's own embedding corpus (see the `own-corpus-index` capability) — SHALL take membership from that scope. No surface SHALL apply exclusion rules of its own; embedding-side rules that decide what text of an included note is embedded SHALL NOT decide which notes are included. The scope SHALL expose both an exclusion-pattern view consumable by the scan's glob call and a per-path membership predicate. The predicate SHALL be authoritative: every path the scan produces SHALL be filtered through it. The pattern view SHALL never exclude a path the predicate would include, so enumerating a vault with the pattern view and enumerating it without both yield the same visible set once the predicate has been applied. The pattern view SHALL NOT carry the dot-path rule, which enumeration already enforces.

#### Scenario: An excluded path is absent from every scan-derived surface

- **WHEN** a note's path is excluded by the vault's scope
- **THEN** it appears in no lexical search result, `query_notes` result, tag/property count, vault-overview count, backlink count, or name-resolution candidate set

#### Scenario: Predicate and glob views agree

- **WHEN** the same vault is enumerated via the scan and, independently, every non-dot file path is enumerated without the exclusion patterns and then tested with the scope's membership predicate
- **THEN** both approaches produce the same set of visible `.md` files

#### Scenario: The corpus covers exactly the visible notes

- **WHEN** the server's own embedding corpus is reconciled against a vault
- **THEN** it holds a shard for every note the scope makes visible — carrying vectors only for those that reach the embedding size gate — and no shard for any note the scope excludes

### Requirement: Dot-paths are always excluded

Any path containing a dot-segment (a path component starting with `.`, e.g. `.obsidian/`, `.smart-env/`, `.git/`, `.neuro-vault/`, `.trash/`) SHALL be excluded from scope unconditionally; no configuration SHALL be able to re-include such a path.

#### Scenario: Dot-directories never surface

- **WHEN** the vault contains `.neuro-vault/eval/golden.yaml` and `.obsidian/workspace.md`
- **THEN** neither path is visible to any discovery surface, with or without a `.neuro-vault/config.json` present

### Requirement: Built-in defaults exclude Templates and root gitignore entries

The scope SHALL exclude `Templates/` and the entries of the vault root's `.gitignore` by default. Gitignore interpretation SHALL be the minimal subset: only the root `.gitignore` file is read; blank lines, comment lines (`#`), and negation lines (`!...`) are skipped; each remaining entry, after stripping a trailing slash, excludes the named path and its entire subtree, anchored at the vault root. Nested `.gitignore` files SHALL NOT be read.

#### Scenario: A gitignored folder leaves discovery

- **WHEN** the vault root's `.gitignore` contains the line `drafts/scratch/`
- **THEN** every note under `drafts/scratch/` is excluded from scope

#### Scenario: Negation lines are ignored

- **WHEN** the root `.gitignore` contains `build/` followed by `!build/keep.md`
- **THEN** `build/keep.md` is excluded like the rest of `build/` (the negation line has no effect)

#### Scenario: No gitignore means defaults are just Templates

- **WHEN** a vault has no root `.gitignore`
- **THEN** the built-in exclusions are `Templates/` plus the unconditional dot-path rule

### Requirement: Per-vault config extends exclusions by union

The scope SHALL read `.neuro-vault/config.json` in the vault root and treat its `"exclusions"` array as additional exclusion globs, combined with the built-in defaults by union; the config SHALL NOT be able to remove a default exclusion. Patterns SHALL be standard globs anchored at the vault root. A missing config file SHALL yield the defaults silently; an unreadable file, invalid JSON, or an invalid shape SHALL yield the defaults and emit a warning on stderr, and SHALL NOT prevent the server from starting.

#### Scenario: Config entries exclude additional paths

- **WHEN** `.neuro-vault/config.json` contains `{ "exclusions": ["Archive/**"] }`
- **THEN** notes under `Archive/` are excluded from scope, and `Templates/` remains excluded

#### Scenario: Missing config falls back silently

- **WHEN** the vault has no `.neuro-vault/config.json`
- **THEN** the scope consists of the built-in defaults and no warning is emitted

#### Scenario: Invalid config warns and falls back

- **WHEN** `.neuro-vault/config.json` contains malformed JSON
- **THEN** the server starts, the scope consists of the built-in defaults, and a warning naming the vault is written to stderr

### Requirement: Scope is discovery, not access control

The scope SHALL govern discovery only. `read_notes` with an explicit path SHALL read a file regardless of its scope membership.

#### Scenario: An excluded template is readable by explicit path

- **WHEN** `Templates/Daily.md` is excluded by the default scope and `read_notes` is called with that exact path
- **THEN** the note's content is returned

