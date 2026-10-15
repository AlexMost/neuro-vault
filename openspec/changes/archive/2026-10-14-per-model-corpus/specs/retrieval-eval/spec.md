## MODIFIED Requirements

### Requirement: The pipeline axis selects the ranking method

The runner SHALL accept `--pipeline` with values `semantic` (pure embedding-similarity ranking) or `fused` (the production RRF fusion of semantic, lexical and expansion legs). One run SHALL evaluate exactly one pipeline and record its value in the report. The runner SHALL NOT accept a corpus-selection axis: the corpus is the one the server owns for the selected model profile, so `--model` selects it.

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

The runner SHALL load its snapshot from the selected profile's corpus directory, `<vault>/.neuro-vault/corpus/<model_key>/`, through the same store and loader the server uses, so the harness and the server can never rank against differently-built snapshots. Before embedding any query, the runner SHALL compare that directory's manifest against the identity of the selected profile and MUST exit non-zero when they differ, naming the identity the corpus was built with and the `neuro-vault-mcp index --vault <path> --model <key>` command that rebuilds it for the selected profile. When the selected profile's corpus is missing or empty, the runner MUST exit non-zero with an error naming that directory and how to produce it (`neuro-vault-mcp index`), and listing the other models whose corpora exist in the vault. The runner SHALL NOT build, rebuild, migrate, lock, or delete any corpus, so evaluating one model leaves every model's corpus as it found it.

#### Scenario: Corpus absent

- **WHEN** `<vault>/.neuro-vault/corpus/` contains no corpus for the selected profile and no other model's corpus
- **THEN** the runner exits non-zero and the error mentions `neuro-vault-mcp index`

#### Scenario: Only another profile's corpus exists

- **WHEN** the runner is invoked with `--model harrier-270m` against a vault whose only corpus is under `.neuro-vault/corpus/granite-97m/`
- **THEN** it exits non-zero before embedding any query, the error names the `harrier-270m` corpus directory as missing, lists `granite-97m` as present, and gives the `index` command with `--model harrier-270m`, and the `granite-97m` corpus is unchanged

#### Scenario: The profile's corpus was built with another identity

- **WHEN** the runner is invoked with `--model harrier-270m` against a vault whose `harrier-270m` corpus manifest records a different embedding version
- **THEN** it exits non-zero before embedding any query, naming the stored identity and the `index` command with `--model harrier-270m`

#### Scenario: Comparing two models keeps both corpora

- **WHEN** `index --model granite-97m`, then `eval --model granite-97m`, then `index --model harrier-270m`, then `eval --model harrier-270m` run on one vault, followed by `eval --model granite-97m` again
- **THEN** the last run succeeds against the unchanged `granite-97m` corpus without any re-indexing

#### Scenario: Shards ranked identically to their vectors

- **WHEN** the corpus contains shards with base64-encoded vectors
- **THEN** the decoded snapshot feeds the ranking functions with notes lacking a note-level vector absent from note ranking
