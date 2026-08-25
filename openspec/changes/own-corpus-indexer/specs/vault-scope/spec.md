# vault-scope Delta

## MODIFIED Requirements

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
- **THEN** it holds an entry for every note the scope makes visible except those below the embedding size gate, and for no note the scope excludes
