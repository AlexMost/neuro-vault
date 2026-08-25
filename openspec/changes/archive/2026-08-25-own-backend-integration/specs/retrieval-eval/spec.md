## ADDED Requirements

### Requirement: The pipeline axis selects the ranking method

The runner SHALL accept one axis, `--pipeline`, with values `semantic` (pure embedding-similarity ranking) or `fused` (the production RRF fusion of semantic, lexical and expansion legs). One run SHALL evaluate exactly one pipeline and record its value in the report. The runner SHALL NOT accept a corpus-selection axis: there is one corpus, the one the server owns.

#### Scenario: Two pipelines over one corpus

- **WHEN** two runs execute with `--pipeline semantic` and `--pipeline fused` on the same vault state
- **THEN** each report records its own `pipeline` value, making the pair a pipeline comparison

#### Scenario: Unknown axis value

- **WHEN** the runner is invoked with `--pipeline reranked`
- **THEN** it exits non-zero naming the supported values

#### Scenario: The retired backend axis is rejected

- **WHEN** the runner is invoked with `--backend sc` or `--backend own`
- **THEN** it exits non-zero rather than silently ignoring the flag

---

### Requirement: Corpus loading

The runner SHALL load its snapshot from the vault's `.neuro-vault/corpus/` shard store, through the same loader the server uses, so the harness and the server can never rank against differently-built snapshots. When the corpus is missing or empty, the runner MUST exit non-zero with an error stating which corpus is missing and how to produce it (`neuro-vault-mcp index`).

#### Scenario: Corpus absent

- **WHEN** `<vault>/.neuro-vault/corpus/` contains no shards
- **THEN** the runner exits non-zero and the error mentions `neuro-vault-mcp index`

#### Scenario: Shards ranked identically to their vectors

- **WHEN** the corpus contains shards with base64-encoded vectors
- **THEN** the decoded snapshot feeds the ranking functions with notes lacking a note-level vector absent from note ranking

---

## MODIFIED Requirements

### Requirement: Comparable JSON reports

Each run SHALL write one JSON report into the repo's gitignored `eval/results/` directory, recording: the code repository's git SHA, the vault repository's git SHA (`vault_sha`), the embedding model id, `pipeline`, the full run configuration (pool sizes, thresholds, fusion weights and k policy in effect), the golden-set size, the aggregate metrics per slice, and per-query results including each query's first relevant rank and its top ranked paths. A dirty working tree SHALL be recorded distinguishably from a clean SHA, and a vault that is not a git repository SHALL record `vault_sha` as null; two reports are comparable if and only if their `vault_sha` values are equal and clean.

#### Scenario: Report identity fields

- **WHEN** a run completes on a vault under git
- **THEN** the report contains non-empty `code_sha`, `vault_sha`, `model_id`, `pipeline`, and `config` fields, and no `backend` field

#### Scenario: Vault not under git

- **WHEN** the vault directory is not a git repository
- **THEN** the run still completes and the report records `vault_sha: null`

---

## REMOVED Requirements

### Requirement: Orthogonal run axes

**Reason**: The harness carried two orthogonal axes, `--pipeline` and `--backend`, so that the corpus the server inherited from the Smart Connections plugin could be ranked against the corpus the server builds itself. This change deletes the plugin reader, leaving one corpus and therefore one axis. Its scenario "Same pipeline across two backends" describes a comparison that can no longer be run — the `sc` loader cannot read a current plugin corpus either, since the plugin migrated its storage layout. Replaced wholesale rather than modified because OpenSpec's MODIFIED apply intentionally refuses to drop a scenario, and this change deliberately retires that one.

**Migration**: Superseded by the ADDED requirement "The pipeline axis selects the ranking method" above. `--pipeline` is unchanged; `--backend` is now rejected with a non-zero exit rather than silently ignored, and reports no longer carry a `backend` field.

### Requirement: Backend corpus loading

**Reason**: The requirement named a backend because there were two of them to choose between. With one corpus its name and its scenario title ("Own shards ranked identically to their vectors") both describe a distinction that no longer exists. Replaced wholesale for the same reason as above — the scenario is renamed, and MODIFIED cannot rename a scenario without appearing to drop it.

**Migration**: Superseded by the ADDED requirement "Corpus loading" above. The loading behaviour is unchanged in substance: the harness reads `.neuro-vault/corpus/` through the same loader the server uses, and still exits non-zero naming `neuro-vault-mcp index` when the corpus is missing or empty.
