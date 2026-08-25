# retrieval-eval Specification

## Purpose
TBD - created by archiving change retrieval-eval-harness. Update Purpose after archive.
## Requirements
### Requirement: Golden set location and schema
The eval runner SHALL read the golden set from the fixed conventional path `<vault>/.neuro-vault/eval/golden.yaml`, where `<vault>` comes from the required `--vault` argument, with no environment-variable or config override. The file SHALL be a YAML list of entries `{ id, query, lang, source, relevant }`: `id` non-empty and unique across the file, `query` a non-empty string, `lang` one of `ua` | `en`, `relevant` a non-empty list of vault-relative note paths. Relevance is binary — ranking any path from an entry's `relevant` list counts as a hit for that query.

#### Scenario: Golden set resolved by convention
- **WHEN** the runner is invoked with `--vault /path/to/vault`
- **THEN** it reads the golden set from `/path/to/vault/.neuro-vault/eval/golden.yaml` and from nowhere else

#### Scenario: Structurally invalid golden set
- **WHEN** the golden set contains an entry missing `query`, an unknown `lang`, a duplicate `id`, or an empty `relevant` list
- **THEN** the runner exits with a non-zero code and an error naming the offending entry, and no report is written

### Requirement: Relevant-path validation gates the run
Before embedding any query, the runner MUST verify that every path in every entry's `relevant` list exists in the vault, and on any miss MUST exit with a non-zero code listing each broken entry (`id` and path) without writing a report. A golden-set entry whose note has moved is a data error to fix, never a silently unwinnable query.

#### Scenario: Broken relevant path fails the run
- **WHEN** an entry's `relevant` list names `Tasks/foo.md` and no such note exists in the vault
- **THEN** the runner exits non-zero, its error output includes that entry's `id` and `Tasks/foo.md`, and no report file is created

#### Scenario: All paths valid
- **WHEN** every `relevant` path in the golden set exists in the vault
- **THEN** validation passes and the run proceeds to ranking

### Requirement: Orthogonal run axes
The runner SHALL accept two independent axes: `--pipeline` with values `semantic` (pure embedding-similarity ranking) or `fused` (the production RRF fusion of semantic, lexical and expansion legs), and `--backend` with values `sc` (vectors from the Smart Connections `.smart-env` corpus) or `own` (vectors from the `.neuro-vault/corpus/` shard store). One run SHALL evaluate exactly one pipeline × backend combination and record both values in its report.

#### Scenario: Same pipeline across two backends
- **WHEN** two runs execute with `--pipeline semantic --backend sc` and `--pipeline semantic --backend own` on the same vault state
- **THEN** each report records its own `backend` value and the identical `pipeline` value, making the pair a backend comparison

#### Scenario: Unknown axis value
- **WHEN** the runner is invoked with `--pipeline reranked` or `--backend foo`
- **THEN** it exits non-zero naming the supported values

### Requirement: Backend corpus loading
The `sc` backend SHALL load its snapshot from the vault's Smart Connections corpus, and the `own` backend SHALL load its snapshot from the vault's `.neuro-vault/corpus/` shard store; both produce the same in-memory snapshot shape consumed by the ranking pipeline. When the selected backend's corpus is missing or empty, the runner MUST exit non-zero with an error stating which corpus is missing and how to produce it (for `own`: run `neuro-vault-mcp index`).

#### Scenario: Own corpus absent
- **WHEN** `--backend own` is selected and `<vault>/.neuro-vault/corpus/` contains no shards
- **THEN** the runner exits non-zero and the error mentions `neuro-vault-mcp index`

#### Scenario: Own shards ranked identically to their vectors
- **WHEN** the own corpus contains shards with base64-encoded vectors
- **THEN** the decoded snapshot feeds the same ranking functions as the `sc` snapshot, with notes lacking a note-level vector absent from note ranking

### Requirement: Positions-only scoring
Each query SHALL be scored against the top-10 ranked note paths produced with similarity threshold 0 — production similarity thresholds are model-scale-bound and MUST NOT filter eval rankings. The runner SHALL compute precision@3 (mean over queries of |relevant ∩ top-3| / 3), MRR (mean over queries of 1 / rank of the first relevant hit, 0 when no relevant path appears in the top-10), and hit@3 (fraction of queries with at least one relevant path in the top-3), each reported for three slices: overall, `lang: ua`, and `lang: en`.

#### Scenario: Metrics on a known ranking
- **WHEN** a query's `relevant` list contains exactly one path and the pipeline ranks it third
- **THEN** that query contributes 1/3 to precision@3, 1/3 to MRR, and counts as a hit for hit@3

#### Scenario: Relevant note outside top-10
- **WHEN** no path from a query's `relevant` list appears in the pipeline's top-10
- **THEN** that query contributes 0 to precision@3, 0 to MRR, and is not a hit@3

#### Scenario: Language slices
- **WHEN** the golden set mixes `lang: ua` and `lang: en` entries
- **THEN** the report carries each metric computed three times — over all entries, over only `ua` entries, and over only `en` entries

### Requirement: Comparable JSON reports
Each run SHALL write one JSON report into the repo's gitignored `eval/results/` directory, recording: the code repository's git SHA, the vault repository's git SHA (`vault_sha`), the embedding model id, `pipeline`, `backend`, the full run configuration (pool sizes, thresholds, fusion weights and k policy in effect), the golden-set size, the aggregate metrics per slice, and per-query results including each query's first relevant rank and its top ranked paths. A dirty working tree SHALL be recorded distinguishably from a clean SHA, and a vault that is not a git repository SHALL record `vault_sha` as null; two reports are comparable if and only if their `vault_sha` values are equal and clean.

#### Scenario: Report identity fields
- **WHEN** a run completes on a vault under git
- **THEN** the report contains non-empty `code_sha`, `vault_sha`, `model_id`, `pipeline`, `backend`, and `config` fields

#### Scenario: Vault not under git
- **WHEN** the vault directory is not a git repository
- **THEN** the run still completes and the report records `vault_sha: null`

### Requirement: Standalone library execution
The runner MUST rank queries by importing the production ranking modules directly — no MCP client, no running server process. The fused pipeline SHALL reuse the production semantic-retrieval, lexical-search, expansion-flattening and rank-fusion functions so that its ordering matches the production fused ordering under the eval configuration.

#### Scenario: No server required
- **WHEN** the runner executes while no neuro-vault MCP server process exists
- **THEN** the run completes normally

#### Scenario: Fused ordering reuses production fusion
- **WHEN** the fused pipeline ranks a query
- **THEN** the final order is produced by the same rank-fusion function the `search_notes` tool uses, fed by the same leg functions

