# Second eval corpus: public vaults and labelled retrieval sets

Research for [#217](https://github.com/AlexMost/neuro-vault/issues/217), a ticket of wayfinder map [#216](https://github.com/AlexMost/neuro-vault/issues/216). Findings are as of 2026-10-29.

**Question.** Which public corpus could serve as a second eval set next to the owner's personal vault, so a retrieval change can be checked on data anyone can reproduce?

## TL;DR

- **No public corpus is a note vault with labels.** Public Obsidian vaults with a permissive licence are templates or tiny English gardens with no relevance labels. Public retrieval benchmarks have labels but are not vault-shaped (no links, no frontmatter, no titles). The one real Ukrainian vault-shaped corpus found (the Obsidian Help `uk` locale) has no licence.
- **Best fit as a second set: Belebele `ukr_Cyrl` + `eng_Latn`.** CC BY-SA 4.0, expert-annotated, 488 passages and 900 questions per language, the English side is parallel (same passages), so the `ua`/`en` slices are directly comparable. About 60 lines of converter script to point `npm run eval` at it.
- **It complements the personal vault; it does not replace it.** It checks model plus ranking quality on short Ukrainian/English passages with hundreds of queries (the personal golden set has 25). It cannot exercise the wikilink graph, frontmatter, folder breadcrumbs or the lexical backlink tie-break, which are what make `fused` differ from `semantic` on a real vault.
- **Recommendation:** adopt Belebele as an optional, reproducible sanity set; keep the personal vault as the primary eval. Do not build anything heavier (WebFAQ, UA-SQuAD) until Belebele proves insufficient.

## What the harness needs

From [`eval/README.md`](../../eval/README.md): a folder of markdown notes (the vault), `<vault>/.neuro-vault/eval/golden.yaml` (list of `id`, `query`, `lang: ua|en`, non-empty `relevant` vault-relative paths, binary relevance), and a corpus built by `neuro-vault-mcp index --vault <dir>`. Every `relevant` path must exist in the vault's scoped listing or the run fails.

One constraint from the source: notes shorter than `MIN_CHARS = 200` get no vector (`src/lib/obsidian/corpus/types.ts`, `embed-text.ts`), so a relevant note under 200 characters is unwinnable for `semantic`. This matters for short-document benchmarks (below).

The existing bake-off ([`2026-10-embedding-model-bakeoff.md`](2026-10-embedding-model-bakeoff.md)) used a 25-query golden set (21 `ua`, 4 `en`) on 947 notes. At that size one query moves UA MRR by several points, which is the main argument for a larger second set.

## Candidates, ranked

| #   | Candidate                           | Licence                                       | Size                                                        | Language                 | Labels                                      | Shape vs. a vault                                            | Effort to point `npm run eval` at it |
| --- | ----------------------------------- | --------------------------------------------- | ----------------------------------------------------------- | ------------------------ | ------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| 1   | Belebele `ukr_Cyrl` / `eng_Latn`    | CC BY-SA 4.0                                  | 488 passages, 900 questions per language                    | ua, en (parallel)        | yes, expert-annotated, question to passage  | short passages (median ~480 chars), no links/frontmatter     | low: converter script, ~1 hour       |
| 2   | UA-SQuAD (FIdo-AI)                  | card says MIT but text inherits CC BY-SA 4.0  | val: 34 articles, 1,160 paragraphs, 11,496 QAs (~50% impossible) | ua (translated from SQuAD 2.0) | yes, question to paragraph       | paragraphs of Wikipedia articles; articles can be assembled into notes | medium: converter plus filtering    |
| 3   | WebFAQ `ukr` / `eng` (mteb mirror)  | CC BY 4.0 (underlying pages: check source terms) | ukr: 68,501 answers, 6,851 test queries; eng: 5.28M, 10k test | ua, en                   | yes, one answer per question                | FAQ answers, no titles, 45% under `MIN_CHARS`               | medium: converter plus subsampling   |
| 4   | Obsidian Help vault, `uk` and `en`  | none stated; terms of use prohibit copying    | 179 notes per locale, 1.3 MB for `uk`                       | ua; en                   | no, must be authored                        | best shape: frontmatter, wikilinks, headings, folders        | medium: clone, pin SHA, author ~40 queries |
| 5   | Quartz docs (`docs/`)               | MIT                                           | 76 notes, 167 KB                                            | en only                  | no, must be authored                        | wikilinks, frontmatter                                       | medium; too small and English-only   |

### 1. Belebele (`ukr_Cyrl`, `eng_Latn`)

- **What it is.** A multiple-choice reading-comprehension benchmark in 122 language variants; each question is tied to a FLORES-200 passage. MTEB wraps it as `BelebeleRetrieval` (question as query, passage as document, `main_score` nDCG@10, `annotations_creators="expert-annotated"`). [mteb task source](https://github.com/embeddings-benchmark/mteb/blob/main/mteb/tasks/retrieval/multilingual/belebele_retrieval.py), [paper](https://aclanthology.org/2024.acl-long.44/).
- **Licence.** CC BY-SA 4.0 per the [dataset card](https://huggingface.co/datasets/facebook/belebele). Share-alike applies to a redistributed corpus; a generated vault that is not redistributed (built locally by a script) has no obligation, and the repo would only ship the script.
- **Size, measured from the dataset-server rows API (`mteb/belebele`, config `ukr_Cyrl`):** 900 questions, 488 distinct passages (one passage serves about 1.8 questions on average), passage length mean 69 words, median 477 characters, 1% under 200 characters. `eng_Latn` has the same 900 questions over the same 488 passages (the set is parallel), so the `ua` and `en` slices measure the same task.
- **Labels.** Each question has exactly one source passage (`link` field). Binary relevance matches the harness one-to-one: `relevant: [passages/<id>.md]`.
- **Shape gaps.**
  - No links, frontmatter, titles or folders. The `fused` pipeline's backlink tie-break and wikilink graph are inert; `semantic` is the clean read.
  - Questions are written for multiple-choice and some are not standalone. In the Ukrainian sample, queries such as "what, according to the passage, can NOT be considered accurate advice" are tied to a topic only through the passage. Filter negated ("NOT") and passage-referential questions, or accept a noisier number.
  - 488 documents is small: top-10 over 488 candidates is an easy task, so scores will sit high and the benchmark discriminates models more than fine ranking changes.
- **Contamination.** Public test set, widely used. The harrier model card ([`microsoft/harrier-oss-v1-270m`](https://huggingface.co/microsoft/harrier-oss-v1-270m)) lists no training datasets, so overlap cannot be ruled out or confirmed.

### 2. UA-SQuAD (`FIdo-AI/ua-squad`)

- Ukrainian SQuAD 2.0 translated/adapted (semi-automated, post-edited). Validation split: 34 articles, 1,160 paragraphs, 11,496 QAs of which 5,770 (50.19%) are unanswerable and must be dropped. [dataset card](https://huggingface.co/datasets/FIdo-AI/ua-squad).
- **Licence.** Card says MIT but states the text inherits SQuAD's CC BY-SA 4.0. Treat as CC BY-SA 4.0.
- **Fit.** The closest benchmark to a note vault in structure: assemble each of the 34 articles (or each paragraph) as a note and label questions to their paragraph note. The corpus is Wikipedia-derived, translated text, which differs in register from personal notes. Many questions per paragraph, so queries are plentiful, but the corpus is only 34 articles. The card reports the dataset viewer failing on a schema mismatch, so loading needs a custom parser. The test split may be hidden.
- Higher effort than Belebele for a corpus of similar difficulty; second pick if a Wikipedia-article shape is wanted.

### 3. WebFAQ (`ukr`, `eng`)

- FAQ question/answer pairs extracted from web pages (schema.org annotations), 75 languages; the retrieval subset is deduplicated and curated. [paper](https://arxiv.org/abs/2502.20936), [dataset card](https://huggingface.co/datasets/PaDaS-Lab/webfaq-retrieval), [mteb mirror and task](https://github.com/embeddings-benchmark/mteb/blob/main/mteb/tasks/retrieval/multilingual/web_faq_retrieval.py).
- **Licence.** CC BY 4.0; the card tells users to check the original sites' and Common Crawl's terms.
- **Size** (dataset-server `size` for `mteb/WebFAQRetrieval`): `ukr` 68,501 corpus answers, 6,851 test queries and qrels; `eng` 5.28M corpus, 10,000 test queries.
- **Labels.** One answer per question; the card notes other valid answers on other sites are not labelled, so recall is understated (false negatives).
- **Shape gaps.** Corpus rows have an empty title. Measured on a 2,000-row sample of the `ukr` corpus: median answer 222 characters, 45% under `MIN_CHARS = 200`, so those answers get no vector and are unwinnable unless short answers are dropped or concatenated. Content is noisy web text (spam, mixed languages; the card warns language detection is imperfect). Would need subsampling (for example 2,000 queries plus their answers plus random distractors) to keep indexing practical.
- **Contamination.** Has a train split and was built for training dense retrievers; likelihood of overlap with multilingual embedders is high though unverifiable from the harrier card.

### 4. Obsidian Help vault (`uk`, `en` locales)

- The official docs repo [`obsidianmd/obsidian-help`](https://github.com/obsidianmd/obsidian-help): 34 locales, each a stand-alone vault in a subfolder, same `permalink` across locales. `uk` and `en` have 179 notes each; `uk` totals 1.3 MB (GitHub git-trees API, measured). A sampled `uk` note has YAML frontmatter (`permalink`, `description`, `cssclasses`) and dense `[[wikilinks]]` with aliases and folder structure. This is the closest published match to the personal vault's shape, in Ukrainian.
- **Licence: none.** The GitHub API reports `license: null`; no licence file exists at the repo root. Obsidian's [terms](https://obsidian.md/terms) define documentation as Company content and bar users from copying, modifying, translating, publishing or distributing it outside the services. So the vault cannot be vendored or redistributed, and its status for a local clone is unclear (the repo is public, but no licence is granted).
- **Labels: none.** They would be authored by hand (about 40 queries per locale is a day of work to do well), which is the same effort that produced the personal golden set.
- **A pointer-only design is possible.** A `golden.yaml` contains only queries and file paths, not note content, so it could be committed with a pinned upstream commit SHA; each contributor clones the repo themselves. Whether that is acceptable given the terms is the owner's call; flagging, not deciding.
- Product documentation (one topic, instructional prose) is also far from reflective personal notes in vocabulary and query style.

### 5. Quartz docs and other permissive vaults

- [`jackyzha0/quartz`](https://github.com/jackyzha0/quartz) is MIT; `docs/` has 76 notes (167 KB), English, with wikilinks and frontmatter. [`foambubble/foam`](https://github.com/foambubble/foam) is MIT (with some Microsoft-copyright MIT code). Both are documentation, English only, no labels.
- GitHub topic searches (`obsidian-vault`, with licence filter `cc-by-4.0`, `cc-by-sa-4.0`, `cc0-1.0`, `mit`) return templates and starter kits (for example OB_Template, kepano-obsidian, Zettelkasten starter kits), not populated knowledge bases. The only populated CC0 garden found, `tanepiper/obsidian-garden`, has 49 notes (66 KB), English, last pushed in 2022. A search for Ukrainian-language public vaults returned nothing.
- **Verdict.** Too small and English-only to be an eval; at most a fixture for link-graph behaviour, which the existing unit tests already cover.

## Checked and excluded

- **MTEB/MMTEB Ukrainian retrieval tasks.** In the mteb repository (grep of `mteb/tasks` for `ukr`, shallow clone on 2026-10-29), the only retrieval tasks with Ukrainian are `BelebeleRetrieval` and `WebFAQRetrieval` (the rest of the hits are bitext mining, classification, clustering, STS and speech/image tasks). There is no Ukrainian-specific retrieval benchmark in MTEB beyond those two, so candidates 1 and 3 are the "MTEB Ukrainian retrieval" answer.
- **MIRACL, Mr. TyDi, mMARCO.** Not checked individually; no Ukrainian subset appeared in the Hugging Face search by `language:uk` plus text-retrieval tag or in the mteb source search. Treat as "not found", not "proven absent".
- **`overthelex/ua-statute-retrieval`.** CC BY-NC-SA 4.0 (non-commercial) and the repo holds aggregate result tables (MRR/hit@10 per year), not queries and documents. Unusable.
- **MDN `translated-content`.** No `uk` locale (`files/` has es, fr, ja, ko, pt-br, ru, zh-cn, zh-tw).
- **Ukrainian Wikipedia dump.** Text is GFDL and CC BY-SA 4.0 ([Wikimedia dumps legal](https://dumps.wikimedia.org/legal.html)) and would be vault-like if exported per article, but it carries no relevance labels, so queries and judgements would have to be synthesised (LLM-generated, with the usual circularity risk against LLM-based embedders).

## Effort to run Belebele through the harness

No change to `src/` or `eval/` is needed. A converter (outside the shipped package) does:

1. Read `ukr_Cyrl` (and `eng_Latn`) rows of `mteb/belebele`; map each distinct passage (`link`) to `passages/<n>.md`, write the passage text as the body (optionally a heading from the first sentence).
2. Write `<dir>/.neuro-vault/eval/golden.yaml` with `id: bel-ua-<n>`, `query` = the question, `lang: ua`, `relevant: [passages/<n>.md]`, `source: belebele-<revision>`; for the English side use a second directory with `lang: en`. Filter non-standalone questions first; sample ~200 queries per language if indexing time matters.
3. `neuro-vault-mcp index --vault <dir> --model <key>`; `npm run eval -- --vault <dir> --model <key> --pipeline semantic`.

Two directories are needed (one vault per language) because the harness takes one `--vault`; the `ua` and `en` slices are then reported from separate runs. Pin the dataset revision (`mteb` pins `979a211276faa22f671e69d096634193567cfd05`) for reproducibility.

## Recommendation

Adopt Belebele (`ukr_Cyrl` plus `eng_Latn`) as an optional second eval for model and `semantic` ranking checks, built by a script the repo can ship without redistributing data. Keep the personal vault as the primary eval: it is the only corpus with vault-shaped notes, links, and the owner's actual query style, so every conclusion about `fused`, graph tie-break, chunking and breadcrumbs still has to be confirmed there. Do not use WebFAQ unless a much larger query count is needed (and then drop answers under 200 characters). Treat the Obsidian Help `uk` vault as a pointer-only option only if the owner is comfortable with its terms. Neither a public benchmark nor a public vault changes the answer to "does this ranking change help *my* notes".

## Sources

- Harness format and limits: [`eval/README.md`](../../eval/README.md); `MIN_CHARS` in `src/lib/obsidian/corpus/types.ts`.
- Belebele: [paper](https://aclanthology.org/2024.acl-long.44/), [`facebook/belebele`](https://huggingface.co/datasets/facebook/belebele), [`mteb/belebele`](https://huggingface.co/datasets/mteb/belebele), [mteb task source](https://github.com/embeddings-benchmark/mteb/blob/main/mteb/tasks/retrieval/multilingual/belebele_retrieval.py).
- WebFAQ: [paper](https://arxiv.org/abs/2502.20936), [`PaDaS-Lab/webfaq-retrieval`](https://huggingface.co/datasets/PaDaS-Lab/webfaq-retrieval), [`mteb/WebFAQRetrieval`](https://huggingface.co/datasets/mteb/WebFAQRetrieval).
- UA-SQuAD: [`FIdo-AI/ua-squad`](https://huggingface.co/datasets/FIdo-AI/ua-squad).
- Obsidian Help: [`obsidianmd/obsidian-help`](https://github.com/obsidianmd/obsidian-help), [Obsidian terms](https://obsidian.md/terms).
- Others: [`jackyzha0/quartz`](https://github.com/jackyzha0/quartz), [`foambubble/foam`](https://github.com/foambubble/foam), [`tanepiper/obsidian-garden`](https://github.com/tanepiper/obsidian-garden), [`mdn/translated-content`](https://github.com/mdn/translated-content), [`overthelex/ua-statute-retrieval`](https://huggingface.co/datasets/overthelex/ua-statute-retrieval), [Wikimedia dumps legal](https://dumps.wikimedia.org/legal.html), [`microsoft/harrier-oss-v1-270m`](https://huggingface.co/microsoft/harrier-oss-v1-270m).
