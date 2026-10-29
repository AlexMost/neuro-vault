# embedding-model-profiles Specification

## Purpose
Which embedding model the server runs, and what that choice pins. The model is one profile from a closed, verified registry, selected by `--model` and served process-wide. The profile owns everything model-specific: repository and revision, dtype, dimension, pooling, prefixes, token window, template-aware truncation, and the similarity defaults calibrated on its own scale. Rationale: ADR-0017.
## Requirements
### Requirement: The embedding model is chosen from a closed registry of verified profiles

The server SHALL embed only with a model profile from a closed registry compiled into the package, and SHALL NOT accept an arbitrary model repository id from any input. The registry SHALL contain exactly the profiles `harrier-270m`, `granite-97m` and `harrier-0.6b`, with `harrier-270m` as the default. Each profile SHALL pin everything that determines the vectors it produces and how they are compared: the model repository id and an exact repository revision, the weight dtype, the vector dimension, the pooling method, the query prefix and the document prefix, the maximum input length in tokens, and the default similarity thresholds the semantic tools apply. A profile SHALL be added to the registry only after it has been measured on the retrieval eval and verified against the pinned transformers.js version.

#### Scenario: The default profile is harrier-270m

- **WHEN** the server or the `index` subcommand starts without a model selection
- **THEN** every vector it produces comes from `onnx-community/harrier-oss-v1-270m-ONNX` at its pinned revision, int8, 640 dimensions, last-token pooling

#### Scenario: The registry is closed

- **WHEN** a model is requested by a repository id such as `TaylorAI/bge-micro-v2` rather than by a profile key
- **THEN** the request is rejected and no model is loaded

#### Scenario: A profile pins its revision

- **WHEN** a profile's model is loaded
- **THEN** its tokenizer and weights are fetched at the profile's pinned revision, never at the repository's moving default branch

---

### Requirement: One profile serves the whole process

A process SHALL select exactly one profile at startup and SHALL use it for every embedding it produces — query embeddings and indexing embeddings, for every vault it serves. The model weights for that profile MAY be held by the shared daemon on the process's behalf rather than in the process itself; either way the process embeds with that one profile only. The corpus identity the process writes to and validates manifests against SHALL be derived from that profile, so a vault's corpus can only be served by a process running the profile that built it, whether the model is local or shared.

#### Scenario: Two vaults share the selected profile

- **WHEN** a server started with `--model granite-97m` serves two vaults
- **THEN** both vaults are indexed and queried with `granite-97m`, and only one model is loaded — in the daemon by default, or in the process with `--no-shared`

#### Scenario: The corpus identity follows the profile

- **WHEN** a process running `granite-97m` writes a corpus manifest
- **THEN** the manifest names `granite-97m`, its repository id and revision, and 384 dimensions

#### Scenario: The identity does not depend on where the model lives

- **WHEN** one process embeds `granite-97m` through the daemon and another with `--no-shared`
- **THEN** both write the same corpus identity

### Requirement: Queries and documents are embedded through separate calls

The embedding provider SHALL expose query embedding and document embedding as separate operations and SHALL report the identity of the model that produces its vectors. Query embedding SHALL prepend the active profile's query prefix; document embedding SHALL prepend the document prefix, which is empty for every registered profile. Callers SHALL NOT add or know a prefix themselves. Every returned vector SHALL have the profile's dimension and unit length.

#### Scenario: A query carries the instruction prefix

- **WHEN** the search path embeds the query `векторний пошук` under `harrier-270m`
- **THEN** the model input begins with the profile's instruction prefix `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ` followed by the query text

#### Scenario: A document carries no prefix

- **WHEN** the indexer embeds a note's text under `harrier-270m`
- **THEN** the model input is the note's embed text alone, with no instruction prefix

#### Scenario: Vectors are unit-length at the profile's dimension

- **WHEN** any text is embedded under any registered profile
- **THEN** the vector's length equals the profile's dimension and its L2 norm is 1 within floating-point tolerance

---

### Requirement: Truncation preserves the special-token template

The local provider SHALL tokenise input itself rather than delegating truncation to a pipeline that applies special tokens before truncating. It SHALL derive the profile tokenizer's special-token template — the ids it places before and after the content — from the tokenizer at load, SHALL encode content without special tokens, SHALL truncate the content so that template, query prefix and content together fit the profile's maximum input length, and SHALL then re-attach the template around the truncated content. A query prefix SHALL never be truncated. Over-long input SHALL be truncated and embedded, never raise.

#### Scenario: A truncated document keeps its end-of-sequence token

- **WHEN** a document whose content encodes to more tokens than the profile's maximum is embedded under a profile whose template ends with an end-of-sequence token
- **THEN** the model input is exactly the maximum length, its last real token is the end-of-sequence token, and the content is cut before it

#### Scenario: Truncation removes content, not the instruction

- **WHEN** a query long enough to exceed the maximum input length is embedded under `harrier-270m`
- **THEN** the model input contains the whole instruction prefix and the template, and only the query's own tokens are cut

#### Scenario: An over-long input returns a vector

- **WHEN** text whose tokenization exceeds the profile's maximum input length is embedded
- **THEN** a vector of the profile's dimension is returned, and no runtime error is raised

---

### Requirement: Padding and pooling follow the tokenizer and the profile

When several texts are embedded together, the provider SHALL pad them to a common length with the tokenizer's pad token on the side the tokenizer declares, and SHALL pool each row by the profile's method over real tokens only: `mean` averages the unpadded positions, `cls` takes the first unpadded position, and `last_token` takes the last unpadded position. A text's vector SHALL NOT depend on which other texts share its batch.

#### Scenario: Last-token pooling selects the end-of-sequence token under right padding

- **WHEN** a short and a long text are embedded together under a last-token profile whose tokenizer pads on the right
- **THEN** the short text's vector is pooled from its own end-of-sequence position, not from a pad position

#### Scenario: Last-token pooling selects the end-of-sequence token under left padding

- **WHEN** a short and a long text are embedded together under a last-token profile whose tokenizer pads on the left
- **THEN** each text's vector is pooled from the final position of its row

#### Scenario: A vector is independent of its batch

- **WHEN** the same text is embedded alone and again in a batch with longer texts
- **THEN** the two vectors are equal within floating-point tolerance

---

### Requirement: Each profile's tokenizer template is verified in CI

The repository's continuous integration SHALL load every registered profile's tokenizer at its pinned revision and SHALL assert the special-token template the provider derives from it, the padding side, and that an input longer than the profile's maximum encodes to exactly the maximum length ending in the template's suffix. Source-level tests with fake tokenizers SHALL cover the truncation, padding and pooling algorithm; this check SHALL cover the real tokenizers.

#### Scenario: A profile whose derived template changes fails CI

- **WHEN** a profile's pinned revision is changed to one whose tokenizer no longer appends its end-of-sequence token
- **THEN** the CI tokenizer check fails naming that profile

---

### Requirement: Similarity defaults belong to the profile

Every default similarity threshold the semantic tools apply SHALL come from the active profile: the `search_notes` effort defaults for `quick` and `deep`, its fallback retry threshold when the profile defines one, the deep block-evidence floor, the default `expansion_floor`, the `get_similar_notes` default threshold, and the `find_duplicates` default threshold. The fallback retry threshold SHALL be optional per profile, and a profile without one SHALL NOT retry. The block-evidence floor SHALL be a default of its own, independent of the `deep` effort default. Tool descriptions that state a default SHALL state the active profile's value, and SHALL NOT state a fallback retry for a profile that defines none. A caller-supplied threshold SHALL be applied as given, on whatever scale the active profile produces.

`harrier-270m` SHALL default to 0.45 at both `quick` and `deep`, SHALL define no fallback, and SHALL keep 0.13 as its block-evidence floor. `granite-97m` and `harrier-0.6b` SHALL keep their effort defaults and fallbacks, and each SHALL carry its `deep` default as its block-evidence floor.

#### Scenario: Two profiles apply their own defaults

- **WHEN** `search_notes` runs with no `threshold` at `effort: "deep"`, once under `harrier-270m` and once under `granite-97m`
- **THEN** each run filters the semantic leg at its own profile's deep default

#### Scenario: The description names the active defaults

- **WHEN** a client lists tools from a server started with `--model granite-97m`
- **THEN** the `search_notes` threshold description states `granite-97m`'s quick, deep and fallback values

#### Scenario: The description of a profile without a fallback states no retry

- **WHEN** a client lists tools from a server started with the default `harrier-270m` profile
- **THEN** the `search_notes` threshold description states its quick and deep values, says there is no retry, and names no fallback value

#### Scenario: The block-evidence floor does not follow the note floor

- **WHEN** a profile's `deep` default and its block-evidence floor differ
- **THEN** the deep block-evidence pass filters at the block-evidence floor, not at the `deep` default

