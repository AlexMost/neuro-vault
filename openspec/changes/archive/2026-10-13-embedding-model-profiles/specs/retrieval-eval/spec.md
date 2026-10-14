## MODIFIED Requirements

### Requirement: Comparable JSON reports

Each run SHALL write one JSON report into the repo's gitignored `eval/results/` directory, recording: the code repository's git SHA, the vault repository's git SHA (`vault_sha`), the embedding model profile key and the full identity of the model that embedded the queries (provider, repository id, revision, dtype, dimension, pooling, maximum input length), `pipeline`, the full run configuration (pool sizes, thresholds, fusion weights and k policy in effect), the golden-set size, the aggregate metrics per slice, and per-query results including each query's first relevant rank, its top ranked paths with the similarity each was ranked by, and the best similarity any of its relevant notes reached regardless of rank. The report's file name SHALL include the profile key and the pipeline. A dirty working tree SHALL be recorded distinguishably from a clean SHA, and a vault that is not a git repository SHALL record `vault_sha` as null; two reports are comparable if and only if their `vault_sha` values are equal and clean.

#### Scenario: Report identity fields

- **WHEN** a run completes on a vault under git
- **THEN** the report contains non-empty `code_sha`, `vault_sha`, `model_key`, `model_id`, `pipeline`, and `config` fields, and no `backend` field

#### Scenario: Ranked paths carry their similarity

- **WHEN** a `semantic` run completes
- **THEN** every ranked path in every `per_query` entry is paired with the similarity it was ranked by, and each entry records the best relevant-note similarity even when no relevant note reached the top-10

#### Scenario: Vault not under git

- **WHEN** the vault directory is not a git repository
- **THEN** the run still completes and the report records `vault_sha: null`

---

### Requirement: The pipeline axis selects the ranking method

The runner SHALL accept `--pipeline` with values `semantic` (pure embedding-similarity ranking) or `fused` (the production RRF fusion of semantic, lexical and expansion legs). One run SHALL evaluate exactly one pipeline and record its value in the report. The runner SHALL NOT accept a corpus-selection axis: there is one corpus per vault, the one the server owns.

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

The runner SHALL load its snapshot from the vault's `.neuro-vault/corpus/` shard store, through the same loader the server uses, so the harness and the server can never rank against differently-built snapshots. Before embedding any query, the runner SHALL compare the corpus manifest against the identity of the selected profile and MUST exit non-zero when they differ, naming the model the corpus was built with and the `neuro-vault-mcp index --vault <path> --model <key>` command that rebuilds it for the selected profile; the runner SHALL NOT rebuild the corpus itself. When the corpus is missing or empty, the runner MUST exit non-zero with an error stating which corpus is missing and how to produce it (`neuro-vault-mcp index`).

#### Scenario: Corpus absent

- **WHEN** `<vault>/.neuro-vault/corpus/` contains no shards
- **THEN** the runner exits non-zero and the error mentions `neuro-vault-mcp index`

#### Scenario: Corpus built by another profile

- **WHEN** the runner is invoked with `--model harrier-270m` against a vault whose corpus manifest names `granite-97m`
- **THEN** it exits non-zero before embedding any query, and the error names `granite-97m` and the `index` command with `--model harrier-270m`

#### Scenario: Shards ranked identically to their vectors

- **WHEN** the corpus contains shards with base64-encoded vectors
- **THEN** the decoded snapshot feeds the ranking functions with notes lacking a note-level vector absent from note ranking

---

## ADDED Requirements

### Requirement: The model axis selects the embedding profile

The runner SHALL accept `--model <key>` with the same profile keys and the same default as the server's `--model`, SHALL embed every query with that profile's query embedding, and SHALL record the profile in the report. An unknown key SHALL exit non-zero listing the allowed keys. The fused pipeline's expansion floor SHALL be the selected profile's default `expansion_floor`, so a `fused` run remains the production pipeline for that profile.

#### Scenario: One profile per run

- **WHEN** the runner is invoked with `--model granite-97m` against a corpus built with `granite-97m`
- **THEN** every query is embedded with `granite-97m` and the report records `model_key: "granite-97m"`

#### Scenario: Unknown model

- **WHEN** the runner is invoked with `--model text-embedding-3-small`
- **THEN** it exits non-zero naming the allowed profile keys

#### Scenario: The fused floor follows the profile

- **WHEN** a `fused` run executes under a profile
- **THEN** the report's `config.expansion_floor` equals that profile's default `expansion_floor`

---

### Requirement: Calibration statistics

With `--stats`, the runner SHALL add to its report the similarity distributions a threshold calibration needs, each summarised as quantiles. Three of them are ranked: the query↔note similarities of the golden queries' ranked candidates, the seed↔neighbour similarities the expansion leg sees, and every in-scope note's top-10 neighbour similarities. Three are unranked: each golden query's similarity to every note, each seed's similarity to every note that is not one of its query's seeds, and every note's similarity to every other note. A seventh holds each note's maximum similarity to any other note. Each similarity default's pass rate SHALL be measured on an unranked population, or for `duplicates` on the per-note maximum: `quick`, `deep` and `fallback` on query↔every note, `expansionFloor` on seed↔every note, `similarNotes` on note↔every note, and `duplicates` on each note's maximum similarity to any other. For each of the selected profile's similarity defaults, the report SHALL record that population and the share of it that the default lets through. It SHALL also record two golden-set guards: how many first-relevant hits inside the deep semantic pool the deep default would filter out, and how far hit@3 drops when the quick default filters the ranking. With `--baseline <report>` naming an earlier `--stats` report, the runner SHALL additionally record, for each default, the threshold on the current profile's population that reproduces the baseline report's pass rate. It SHALL refuse a baseline that measured a default on a different population, before embedding any query. Without `--stats` the report SHALL NOT carry these fields.

#### Scenario: Pass rates per default

- **WHEN** the runner is invoked with `--stats`
- **THEN** the report carries quantiles for each of the seven distributions and, for each similarity default of the selected profile, the fraction of its unranked population at or above it

#### Scenario: A baseline yields suggested thresholds

- **WHEN** the runner is invoked with `--stats --baseline <report>` where the baseline report's `deep` default passed 90 % of its population
- **THEN** the report's suggested `deep` threshold is the value at which 90 % of the current profile's query↔every-note similarities pass

#### Scenario: A baseline measured on another population is refused

- **WHEN** the runner is invoked with `--stats --baseline <report>` where the baseline report measured `deep` on the ranked query candidates
- **THEN** the run fails before embedding any query, naming the file, the default and both populations

#### Scenario: Statistics are opt-in

- **WHEN** the runner is invoked without `--stats`
- **THEN** the report carries no distribution fields
