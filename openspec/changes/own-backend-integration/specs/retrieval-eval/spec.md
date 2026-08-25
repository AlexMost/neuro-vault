## RENAMED Requirements

- FROM: `### Requirement: Orthogonal run axes`
- TO: `### Requirement: The pipeline axis selects the ranking method`

- FROM: `### Requirement: Backend corpus loading`
- TO: `### Requirement: Corpus loading`

---

## MODIFIED Requirements

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

#### Scenario: Own corpus absent

- **WHEN** `<vault>/.neuro-vault/corpus/` contains no shards
- **THEN** the runner exits non-zero and the error mentions `neuro-vault-mcp index`

#### Scenario: Shards ranked identically to their vectors

- **WHEN** the corpus contains shards with base64-encoded vectors
- **THEN** the decoded snapshot feeds the ranking functions with notes lacking a note-level vector absent from note ranking

---

### Requirement: Comparable JSON reports

Each run SHALL write one JSON report into the repo's gitignored `eval/results/` directory, recording: the code repository's git SHA, the vault repository's git SHA (`vault_sha`), the embedding model id, `pipeline`, the full run configuration (pool sizes, thresholds, fusion weights and k policy in effect), the golden-set size, the aggregate metrics per slice, and per-query results including each query's first relevant rank and its top ranked paths. A dirty working tree SHALL be recorded distinguishably from a clean SHA, and a vault that is not a git repository SHALL record `vault_sha` as null; two reports are comparable if and only if their `vault_sha` values are equal and clean.

#### Scenario: Report identity fields

- **WHEN** a run completes on a vault under git
- **THEN** the report contains non-empty `code_sha`, `vault_sha`, `model_id`, `pipeline`, and `config` fields, and no `backend` field

#### Scenario: Vault not under git

- **WHEN** the vault directory is not a git repository
- **THEN** the run still completes and the report records `vault_sha: null`
