# Agent-level A/B: neuro-vault vs. filesystem tools (November 2026)

The [embedding bake-off](2026-10-embedding-model-bakeoff.md) measured the retrieval pipeline in isolation. This document measures the thing a user actually gets: **an agent answering questions about a vault**, once with neuro-vault and once with the plain filesystem tools every coding agent already has. The question is not "does the index rank well?" but "does an agent with this server answer better, cheaper, or both, than the same agent with `grep`?"

Findings are as of 2026-11-01; § After the fixes re-measures two cells on `main` after the suggestions below shipped. Every number below comes from 720 agent runs across four conditions (two vaults × two models), each question run three times per arm, judged against a golden set and by a blind LLM judge. Both vaults are private; this report describes them only by size and shape and contains no queries, note titles or note content.

## TL;DR

- **neuro-vault is always cheaper and leaner.** Across all four conditions the agent makes **about half the tool calls** (2.4–4.2 vs 5.9–7.1), pays **10–39% less per answer**, pulls **9–56% less text into its context**, and cites fewer non-existent notes.
- **Whether it is also better depends on two multipliers: vault size and model strength.**
  - Large vault (~4.9k notes) + small model (Haiku 5.5): neuro-vault wins clearly — **recall 0.90 vs 0.75**, judge grounding 2.67 vs 2.38, stable wins 14 vs 10.
  - Small vault (~1k notes) + strong model (Opus 5.5): `grep` is slightly better — recall 0.63 vs 0.58, stable wins 10 vs 5.
  - The other two cells sit in between, close to parity.
- **neuro-vault narrows the gap between models.** On the large vault, Haiku with neuro-vault (recall 0.90) out-recalls Opus with `grep` (0.85) at **~3% of the cost per answer**. Moving from Opus to Haiku costs the `grep` agent twice as much grounding as the neuro-vault agent on the small vault (−0.50 vs −0.25).
- **Single-token queries flip with vault size.** On the small vault they are neuro-vault's worst class (Δrecall −0.20 on both models); on the large vault they are its best (+0.36 on Haiku), because a single term matches dozens to hundreds of files and only a ranked list survives that.
- **Most of the gain over `grep` is not the semantic leg.** A third arm — neuro-vault with `--no-semantic` — on Haiku: on the large vault recall goes `grep` 0.75 → lexical-only 0.86 → full 0.90, so about three quarters of the gain comes from lexical ranking, provenance and structured reads; the semantic leg adds the last quarter, almost all of it on paraphrase (concept) questions. On the small vault removing the semantic leg changes nothing measurable.
- **The first fixes closed most of the small-vault gap.** After [#267](https://github.com/AlexMost/neuro-vault/issues/267) (lexical `limit`, weighted fusion of query variants, a per-variant cut hint) and the retired expansion leg ([#276](https://github.com/AlexMost/neuro-vault/pull/276)), Vault A · Opus moved from judge −0.29 to −0.11 against `grep` and from 5 vs 10 stable wins to 7 vs 7; single-token recall went 0.49 → 0.62 (`grep` 0.69). Vault B · Haiku did not regress (recall 0.90 → 0.91).
- A strong model with `grep` is a strong baseline: it writes its own synonym regexes, guesses inflections and reads whole files. Against it, on a small vault, the server's edge is efficiency, not answer quality.

## Setup

### Two arms, identical except for the search channel

Each question ran as its own `claude -p` process (Claude Code 2.1.311, `--output-format stream-json`), from a fresh empty working directory (so no project instructions leaked in), with the vault attached via `--add-dir`, `--max-turns 25`, `--permission-mode dontAsk` and a $3 per-run budget fuse.

| | **nv** (neuro-vault) | **fs** (filesystem) |
|---|---|---|
| Built-in tools | `Read` | `Read`, `Grep`, `Glob`, `Bash` (allow-listed to `rg`, `grep`, `find`, `ls`, `cat`, `head`, `sed`, `wc`) |
| MCP | neuro-vault-mcp 17.5.0, read tools only (`create_note`, `edit_note`, `set_property`, `remove_property` disallowed) | none (`--strict-mcp-config` with an empty server list) |
| Disallowed for both | `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebSearch`, `WebFetch`, `Agent`, `Task`, `Skill` | same |

Both arms got the same appended system prompt: where the vault lives, the vault's own conventions and lifecycle notes (taken from its `for-external-agents.md`, with every tool name removed so neither arm got a hint), and one line on note language and frontmatter. Both got the same question wrapper, asking for 3–6 sentences and a list of the vault paths the answer relies on, or exactly "nothing in the vault" when there is nothing.

Job order alternated arms and shuffled questions (seed 42); at most four runs in parallel. Semantic search used `harrier-oss-v1-270m` (int8), the current default.

### Models and judge

- **Opus 5.5** (`claude-opus-5-5`, effort medium) and **Haiku 5.5** (`claude-haiku-5-5`) as the answering agent, same model on both arms of a condition.
- **Judge: Opus 5.5**, no tools, one call per (question, repetition). It sees the question, the golden notes (title + first 300 characters of each) and the two answers as "Answer 1 / Answer 2" in a recorded random order. It is not told that the comparison is about tools. It returns grounding and usefulness on a 0–3 scale and a preference.

### Vaults

| | Vault A — personal | Vault B — corporate product KB |
|---|---|---|
| Notes | 1,012 | 4,933 (two vaults served by one server: 4,876 + 57) |
| Shape | PARA-style personal knowledge base: resources, daily notes, archive, reflections, tasks, inbox, ideas, projects | ~85% mirrored internal wiki pages; ~14% generated entity cards (teams, product modules, metrics, missions, a ~450-note people registry); a small team vault with issue-tracker snapshots and wiki pages |
| Authored by | one owner, by hand | generated by sync scripts from the wiki, the issue tracker and a structured model of the product |
| Median / mean / p90 words per note | 193 / 334 / 781 | 245 / 510 / 1,155 |
| Wikilinks per note | 5.4 | 5.1 |
| Cyrillic share of letters | 62% (Ukrainian-heavy, English mixed in) | 60% |
| Notes with frontmatter | 99% | 100% |

### Questions and golden sets

| | Vault A | Vault B |
|---|---|---|
| Answerable questions | 20 | 30 |
| Control questions (no answer in the vault) | 5 | 5 |
| By class (answerable): concept / name / single-token | 7 / 7 / 6 | 12 / 12 / 6 |
| By language (answerable): ua / en / mixed | 8 / 5 / 7 | 11 / 13 / 6 |
| Relevant notes per answerable question | 1–10 | 1–40 (one graph question asks for every backlink of a hub note) |
| Golden set written by | the vault owner (the retrieval harness's own golden set, sampled stratified by class × language) | the agent, from a candidate pool that was the union of neuro-vault `search_notes` results and an independent regex scan of every file; 11 of 30 rows marked low-confidence |

*Concept* questions name a topic in other words than the notes use; *name* questions name an entity (a project, a person, an identifier); *single-token* questions are one word or abbreviation.

### Metrics

- **From the transport, not from the agent's words**: cost (`total_cost_usd`), turns, tool calls, bytes of tool results (context pulled in), whole-file reads, denied tool calls — all from the final stream-json events.
- **Against the golden set**: cited paths are parsed from the answer; *hit* = at least one relevant note cited, *recall* = share of relevant notes cited, *precision* = share of cited notes that are relevant, *hallucinated paths* = cited paths that do not exist. For controls: *abstained* = answered "nothing in the vault" and cited nothing.
- **Judge**: grounding and usefulness, 0–3.
- **Stable win**: an arm beat the other in at least 2 of the 3 repetitions of a question (quality = mean of the judge's two scores, ties broken by recall).

All per-question numbers are first averaged over the three repetitions, then averaged over questions.

## Results

### The matrix (answerable questions, nv minus fs)

| | Vault A (~1k notes) | Vault B (~4.9k notes) |
|---|---|---|
| **Opus 5.5** | recall −0.05 · grounding −0.25 · stable wins nv 5 / fs 10 (5 none) | recall +0.02 · grounding +0.01 · nv 8 / fs 12 (10 none) |
| **Haiku 5.5** | recall −0.01 · grounding 0.00 · nv 7 / fs 10 (3 none) | **recall +0.15 · grounding +0.29 · nv 14 / fs 10 (6 none)** |

### Every metric, every condition (answerable questions)

| | A · Opus fs | A · Opus nv | A · Haiku fs | A · Haiku nv | B · Opus fs | B · Opus nv | B · Haiku fs | B · Haiku nv |
|---|---|---|---|---|---|---|---|---|
| hit | **0.87** | 0.80 | **0.80** | 0.75 | 1.00 | 1.00 | 0.98 | **1.00** |
| recall | **0.63** | 0.58 | 0.50 | 0.49 | 0.85 | 0.87 | 0.75 | **0.90** |
| precision | 0.32 | 0.33 | 0.30 | 0.30 | 0.49 | **0.54** | **0.43** | 0.41 |
| judge grounding | **2.48** | 2.23 | 1.98 | 1.98 | 2.79 | 2.80 | 2.38 | **2.67** |
| judge usefulness | **2.52** | 2.18 | **2.12** | 1.90 | **2.77** | 2.62 | 2.50 | 2.49 |
| hallucinated paths / answer | 0.08 | 0.05 | 0.12 | **0.02** | 0.07 | 0.06 | 0.09 | 0.04 |
| cost / answer | $0.183 | **$0.141** | $0.0049 | **$0.0030** | $0.190 | **$0.170** | $0.0065 | **$0.0052** |
| tool calls | 6.4 | **3.4** | 5.9 | **2.4** | 6.1 | **3.3** | 7.1 | **4.2** |
| tool-result KB in context | 32.5 | **25.6** | 28.9 | **12.7** | 30.7 | **27.9** | 42.4 | **25.5** |
| whole-file reads | 2.2 | 0.0 | 2.1 | 0.0 | 2.1 | 0.0 | 3.3 | 0.0 |

Wall-clock time is reported only for Vault B, where the index was fully built and the shared background process was otherwise idle: neuro-vault answered in **23.7 s vs 32.9 s** on Opus (−28%) and 16.1 s vs 17.8 s on Haiku. Vault A's timings are not comparable: midway through those runs the same background process was rebuilding Vault B's index.

### By query class (Δ nv − fs)

| class | A · Opus | A · Haiku | B · Opus | B · Haiku |
|---|---|---|---|---|
| concept — recall / judge | −0.03 / −0.38 | +0.06 / +0.14 | −0.00 / −0.10 | +0.05 / −0.04 |
| name — recall / judge | +0.06 / −0.19 | +0.07 / −0.05 | +0.02 / −0.15 | +0.15 / +0.07 |
| single-token — recall / judge | **−0.20** / −0.31 | **−0.19** / −0.47 | +0.05 / +0.17 | **+0.36** / **+0.64** |

"judge" here is the mean of grounding and usefulness.

### By query language (Δ recall nv − fs, answerable)

| language | A · Opus | A · Haiku | B · Opus | B · Haiku |
|---|---|---|---|---|
| ua | −0.10 | −0.16 | +0.03 | +0.22 |
| en | +0.04 | +0.18 | +0.03 | +0.11 |
| mixed | −0.06 | +0.03 | −0.03 | +0.11 |

### Controls (questions with no answer in the vault)

Both arms abstained correctly in 87–100% of runs in every condition. The neuro-vault agent spent less on an empty question (e.g. Vault A · Opus: $0.072 vs $0.112) and pulled 1.5–3× less text into its context (5.9 KB vs 16.1 KB).

### Stability across repetitions

Quality winners per repetition, nv / fs / tie:

| | r1 | r2 | r3 |
|---|---|---|---|
| A · Opus | 6 / 12 / 7 | 7 / 8 / 10 | 6 / 10 / 9 |
| A · Haiku | 10 / 10 / 5 | 8 / 12 / 5 | 13 / 8 / 4 |
| B · Opus | 10 / 14 / 11 | 9 / 15 / 11 | 13 / 16 / 6 |
| B · Haiku | 18 / 11 / 6 | 16 / 13 / 6 | 15 / 12 / 8 |

Within one question, the judge's score varies by ~0.25 points between repetitions; differences smaller than about half a point on a single question are noise. The direction of each condition holds in every repetition except A · Haiku, which is the closest cell to parity.

### Semantic ablation (Haiku 5.5)

A third arm — the same neuro-vault setup with `--no-semantic`, so `search_notes` answers from its lexical leg alone — ran on both Haiku cells with the same questions, three repetitions each. The judge compared it pairwise with the full neuro-vault arm. Recall against the golden set, answerable questions:

| | Vault A `grep` | Vault A lexical-only | Vault A full | Vault B `grep` | Vault B lexical-only | Vault B full |
|---|---|---|---|---|---|---|
| all | 0.50 | 0.50 | 0.49 | 0.75 | 0.86 | **0.90** |
| concept | 0.36 | 0.47 | 0.42 | 0.81 | 0.76 | **0.86** |
| name | 0.52 | 0.53 | 0.59 | 0.80 | 0.95 | 0.95 |
| single-token | 0.64 | 0.50 | 0.46 | 0.52 | **0.91** | 0.88 |

Lexical-only vs full, judged pairwise: Vault A — mean judge score 1.95 vs 1.88, stable wins 5 / 3 (12 without a stable winner); Vault B — 2.59 vs 2.59, stable wins 13 / 9 (8 without), precision 0.37 vs 0.41. Cost, calls and context are the same within a few percent.

The semantic leg's measurable contribution to answers is one cell: paraphrase questions on the large vault (recall +0.10, judge +0.17). Elsewhere it is noise-level. The log count points the same way: across all four main conditions, 5–11% of the golden notes the neuro-vault agent cited reached it through the semantic leg alone. That is a small share, not evidence of a noisy leg. A retrieval-level follow-up on the production pipeline found semantic-only results about as precise as lexical-only ones (15% vs 23% relevant on Vault A, 18% vs 6% on Vault B; results found by both legs: 70% and 45%), and there removing the semantic leg cost MRR 0.16 and 0.33. The agent closes most of that retrieval gap itself by rephrasing and searching again, which is why the agent-level difference is so much smaller than the retrieval-level one.

## What the logs show

These come from the raw tool-call streams, not from the summary metrics.

1. **The semantic leg contributes, narrowly, on the small vault.** In Vault A · Opus, 11 of the 112 golden notes the neuro-vault agent cited were surfaced *only* by the semantic leg (no lexical match). Two of those notes were effectively unreachable for the `grep` agent: cited 3/3 by nv vs 0/3 and 1/3 by fs — both cases where the question used different words than the note. The price is a wider list: 38% of all results the neuro-vault agent saw (284 of 748) came from the semantic leg alone, and few of them were golden notes — though by retrieval-level precision they are no worse than lexical-only matches (see the ablation above).
2. **The neuro-vault agent stops early.** It makes 40–60% fewer calls. A tidy ranked list reads as complete; on the small vault that costs recall on single-token queries, where the `grep` agent keeps going.
3. **The small-vault single-token gap is ranking inside the lexical leg, not word-prefix matching.** No golden note for a single-token question on Vault A contains the query only as a substring (0 of 23), so a substring mode would not have closed a single measured loss. The gap comes from three questions. In the largest one, broad synonyms the agent adds to its own query array share one lexical pool with the exact term, and their title-tier matches push the exact term's body matches out; replaying the agent's real calls through the production pipeline, the first term alone retrieves 2/2 golden notes, the agent's array 0/2, and a larger merged cap does not help. The second is a hyphenated term the notes spell as one word. The third is the agent searching too narrowly — most of its golden notes never contain the query.
4. **`truncated` is on so often that it carries no signal.** It is `true` in 84% of deep hybrid calls on Vault A · Opus and 98% on Vault B · Opus; the agent stops right after a truncated result in 72–81% of runs. String queries (12–19% of calls) get no lexical totals at all.
5. **`limit` is ignored in lexical mode.** In `mode: "lexical"` the leg returns the effort profile's cap whatever `limit` the call passes; agents asked for more 71 times across the four conditions, and most of those calls came back with five notes per vault and `truncated: true`.
6. **On a large vault the `grep` agent drowns.** Single-token queries on Vault B match 45–313 files each (five of six match more than 100). The `grep` agent with Haiku ends with single-token recall 0.52; the neuro-vault agent 0.88.
7. **Where Opus + `grep` still wins on Vault B, it is answer completeness, not retrieval.** Grounding is tied in 72 of 105 judged pairs; the `grep` agent's usefulness edge comes from answers that pull more detail out of whole files on questions whose facts are spread across several notes.

## After the fixes

Re-measured on `main` at `a107465`, which contains the three #267 changes — `limit` reaches the lexical pool in lexical mode ([#268](https://github.com/AlexMost/neuro-vault/pull/268)), query variants fused by weighted reciprocal rank inside the lexical leg ([#269](https://github.com/AlexMost/neuro-vault/pull/269)), a hint when the agent's own variant was cut ([#272](https://github.com/AlexMost/neuro-vault/pull/272)) — and the retired expansion leg ([#276](https://github.com/AlexMost/neuro-vault/pull/276)).

Method: only the neuro-vault arm was re-run, with every question and three repetitions, against the **same `grep` answers** as before, so each judge comparison is the new neuro-vault answer against the old `grep` answer. The build was pinned in its own worktree and served by its own background process (the process key hashes the CLI build, so it never met the installed version's process), warmed until every vault reported `semantic_status: ready` before the first run. Two cells: where neuro-vault lost (Vault A · Opus) and where it won most (Vault B · Haiku, the regression risk).

**Vault A · Opus 5.5** (answerable, n=20; `grep` unchanged)

| | before | after | `grep` |
|---|---|---|---|
| recall | 0.58 | 0.60 | 0.63 |
| judge, nv − `grep` | −0.29 | **−0.11** | — |
| stable wins nv / `grep` / none | 5 / 10 / 5 | **7 / 7 / 6** | — |
| single-token recall | 0.49 | **0.62** | 0.69 |
| name — judge, nv − `grep` | −0.19 | **+0.12** | — |
| concept — judge, nv − `grep` | −0.38 | −0.26 | — |

**Vault B · Haiku 5.5** (answerable, n=30)

| | before | after | `grep` |
|---|---|---|---|
| recall | 0.90 | **0.91** | 0.75 |
| concept / name / single-token recall | 0.86 / 0.95 / 0.88 | 0.86 / 0.98 / 0.88 | 0.81 / 0.80 / 0.52 |
| judge, nv − `grep` | +0.14 | +0.06 | — |
| stable wins nv / `grep` / none | 14 / 10 / 6 | 15 / 12 / 3 | — |

- **The small-vault gap mostly closed.** The clearest case is the single-token question whose exact term was crowded out by the agent's own synonyms: recall 0.33 → 1.00 in all three repetitions. The agent now follows its first search with a lexical call whose `limit` equals the match count the cut hint reported, and gets the whole list instead of five notes.
- **No regression on the large vault.** Recall holds or rises in every class; the edge over `grep` (+0.16 recall) is intact. The judge delta moved by 0.08, within the repetition noise.
- **One small-vault loss is a side effect of `limit` working.** On one concept question the golden note sits first in the lexical list in all three runs, but a 20–30-note list now also carries several notes that mention the query as an example, and the agent reads those instead. The retrieval is right; the choice is not.
- **Cost of the change**: about 8% more text pulled into context and about 4% more per answer on both vaults — the expected price of `limit` returning what was asked for.
- **What is left**: on the small vault, single-token recall still trails `grep` by 0.07 — one hyphenated-compound question (suggestion 4) and one where the agent searches too narrowly.

## Caveats

- **Three repetitions per question.** Stable wins are more reliable than small deltas in means.
- **The two vaults differ in more than size**: content type (personal writing vs generated cards and wiki pages), question style and golden-set authorship. Size is the most direct explanation — the single-token mechanism shows it — but two vaults cannot isolate it.
- **Vault B's golden set was drafted by the agent**, not by the knowledge base's owner. The candidate pool included both channels (neuro-vault results and a regex scan of every file), and five notes were added from semantic-only candidates after the semantic index finished building.
- **The judge prefers longer answers**: in 68% of non-tied usefulness decisions it picked the longer one. Average answer length is nearly equal between arms, so this does not systematically favour either, but it explains part of the `grep` agent's usefulness edge on Vault A · Opus, where its answers ran ~10% longer.
- **The judge is the same model as the Opus agent** and sees the golden notes, so grounding partly overlaps recall.
- **14 of Vault A's 25 golden queries were synonym arrays**; the experiment used only the first element, so some relevant notes are out of reach from one word for both arms.
- **Context rot was not measured**: every question is a fresh session, so the context savings (9–56%) are not yet shown to pay off in long sessions.

## What this suggests for neuro-vault

Ordered by strength of evidence:

Tracked in [#267](https://github.com/AlexMost/neuro-vault/issues/267); items 1–3 shipped as [#268](https://github.com/AlexMost/neuro-vault/pull/268), [#269](https://github.com/AlexMost/neuro-vault/pull/269) and [#272](https://github.com/AlexMost/neuro-vault/pull/272) and are re-measured in § After the fixes:

1. **Make `limit` reach the lexical pool in lexical mode** ([#264](https://github.com/AlexMost/neuro-vault/issues/264)) — the cheapest fix; the contract does not change.
2. **Fuse query variants by weighted RRF inside the lexical leg** ([#265](https://github.com/AlexMost/neuro-vault/issues/265)), so broad variants cannot crowd out the exact term — the largest measured lever on small-vault single-token questions (replay: +0.09 recall at the same result count; a naive round-robin hurt the large vault, a weighted fusion did not).
3. **Tell the agent when its own variant's lexical matches were cut** ([#266](https://github.com/AlexMost/neuro-vault/issues/266)), instead of a `truncated` flag that is almost always on; lexical totals for string queries and paging stay in [#187](https://github.com/AlexMost/neuro-vault/issues/187).
4. **Normalise hyphenated and closed compounds in the lexical leg** — one measured loss.
5. **Visible index rebuilds** — after the 17.x upgrade, Vault B's corpus rebuilt for 72 minutes with no surfaced progress, and the first call during warm-up returned a dependency error rather than a status.

Not suggested, despite looking plausible from the summary tables: a substring mode (the data does not support it, and [#231](https://github.com/AlexMost/neuro-vault/issues/231) moved away from substring matching because of its noise) and demoting single-leg semantic hits ([#224](https://github.com/AlexMost/neuro-vault/issues/224) decided against it, and a replay shows no gain).

## Next measurements

- **Semantic ablation on Opus**: the Haiku ablation is above; on Opus the semantic leg's share is not yet measured.
- **Size ablation**: the same Vault B questions against only its ~700 structured cards vs the full ~4.9k notes, to separate size from content type.
- **Long sessions**: 10–15 questions in one session, comparing answer quality at the end vs the start, to see whether the context savings matter.
- **Embedding models**: retrieval-level first (semantic-leg recall@k on concept questions via the [eval harness](../../eval/README.md)); agent-level only if retrieval moves.
- **An owner-labelled golden subset for Vault B**, and **a third model** between Opus and Haiku.
- **Separate the shipped changes**: § After the fixes measures #267 and the retired expansion leg together; their individual shares are not split.
- **Hyphenated compounds** (suggestion 4) are the largest single-token loss left after the fixes.

## Reproducing

The runner was a throwaway script (not in the repo: it embeds local paths and reads private golden sets). Everything it did is described above; the essential pieces are the two tool configurations in § Setup, the shared system prompt with tool names removed, one fresh process and one empty working directory per run, metrics taken from the final stream-json events, and the blind pairwise judge. Raw transcripts stay private because they contain vault content.
