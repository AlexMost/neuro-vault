# Multi-Query Support for `search_notes`

**Date:** 2026-04-26

**Status:** Approved for planning

Дозволити `search_notes` приймати масив запитів за один виклик. Зараз агент робить N послідовних викликів для синонімів і UA/EN-варіацій — це найширший N+1 патерн у roadmap за звітом [[Inbox/neuro-vault-usage/2026-W17]] (30 послідовних пар у 14 з 20 сесій).

## Контекст

AGENTS.md (і MCP server instructions від [[Design hybrid search routing for neuro-vault MCP]]) рекомендують:

> для fuzzy queries: rewrite to 2–4 keywords; run separate searches per concept, synonym, and UA/EN variant

Правило коректне на рівні retrieval — синонім/мова дають різні embeddings і різні попадання. Але реалізоване воно через **N окремих викликів** замість одного multi-query — кожен платить MCP-roundtrip, embeddings рахуються N разів, merge-and-dedupe лягає на LLM.

Multi-query як параметр зберігає семантику правила (декілька векторів), але виконує batch-friendly: один batch-embed, один merge на сервері, один tool-call.

## Scope

### Сигнатура

`search_notes` приймає `query` як рядок **або** масив рядків:

```ts
{
  query: string | string[],   // 1..8 елементів
  mode?: "quick" | "deep",
  limit?: number,
  threshold?: number,
  expansion?: boolean,
  expansion_limit?: number
}
```

Поведінка для `string` — без змін (back-compat). Для `string[]` — нижче.

### Поведінка multi-query

1. **Validation:** `1 <= queries.length <= 8`. Поза межами → `INVALID_PARAMS`. Дублі → dedupe перед embed.
2. **Embedding:** один batch-прохід через embedding pipeline (`bge-micro-v2`).
3. **Retrieval:** кожен query шукає свій top-K з тим самим `mode` / `threshold` / `limit`.
4. **Merge:** об'єднати по `path`. Для дубля — взяти max similarity і зібрати список усіх matched queries.
5. **Re-rank:** sort за max similarity desc.
6. **Cap:** обрізати до `min(limit × N, 50)`, де `N` — кількість унікальних queries після dedupe. Hard cap 50 — про розмір відповіді LLM, не про retrieval depth. `truncated: true` якщо merged кандидатів було більше за цей cap.

### Output shape

```jsonc
{
  "results": [
    {
      "path": "Notes/foo.md",
      "similarity": 0.81,                          // максимум по всіх matched queries
      "matched_queries": ["оптимізація", "optimization"]
    }
  ],
  "blockResults": [...],                           // якщо mode === "deep" — те саме merge
  "truncated": false                               // true якщо merged кандидатів > min(limit × N, 50)
}
```

`matched_queries` — для прозорості: видно який синонім/мова сприяли влучанню. Допомагає LLM швидше зрозуміти що працює, і дає сигнал якщо один із запитів даремний.

### Backward compatibility

- `query: string` повертає поточний shape **без** `matched_queries` (callsites не ламаються)
- `query: string[]` завжди повертає `matched_queries` поруч з кожним результатом
- Detection — runtime тип, не два окремих tools

### Server instructions

Оновити секцію `## Search routing` (з [[Design hybrid search routing for neuro-vault MCP]]):

- Видалити правило "call multiple times with different queries for synonyms or multi-language searches"
- Додати: "Pass `query: string[]` (1–8 елементів) для синонімів / UA–EN / переформулювань — це дешевше і повертає merged результат"

`AGENTS.md` цього vault — оновити після релізу і smoke-test.

## Тести

- [ ] Unit:
  - `query: string` — старий path, без `matched_queries`
  - `query: string[]` довжиною 1 → еквівалент string-варіанта
  - Дублі в масиві queries → dedupe до embed
  - 0 елементів / >8 елементів → `INVALID_PARAMS`
  - Merge: один path у двох queries → один результат, `matched_queries` має обидва
  - Sort: max similarity desc
  - Cap: `limit=10`, 3 queries з різними top-10 → return ≤30
  - Cap: `limit=10`, 1 query → return ≤10 (back-compat)
  - `truncated: true` коли merged > `min(limit × N, 50)` (наприклад `limit=10`, 8 queries з overlap)
- [ ] Integration на реальних embeddings:
  - `["оптимізація", "optimization"]` — UA/EN варіація має знайти більше нотаток, ніж окремо
  - `["MCP server", "MCP сервер", "neuro-vault"]` — три синоніми, мердж стабільний
- [ ] Performance: multi-query ×3 не більше 1.5× латентності одиночного (за рахунок batch embed)

## Out of scope

- Per-query вага / boost — поки equal weight
- Per-query різні `limit` / `threshold` — глобальні параметри для всіх
- Auto-expansion на синоніми (LLM генерує синоніми сам)
- Multi-query для `get_similar_notes` — окрема задача якщо знадобиться

## Definition of Done

- [ ] `search_notes` приймає `query: string | string[]`
- [ ] Merge + `matched_queries` реалізовано і покрито тестами
- [ ] Backward-compat зберігається (string callsites не міняються)
- [ ] Tool description оновлено з прикладом multi-query
- [ ] MCP server instructions оновлено (Search routing секція)
- [ ] Manual smoke на реальному vault — UA/EN, синоніми
- [ ] Опубліковано нову мінорну версію в npm
- [ ] `AGENTS.md` цього vault оновлено

## Connections

- [[neuro-vault]]
- [[Design hybrid search routing for neuro-vault MCP]] — джерело Search routing секції
- [[Add query tool to neuro-vault]] — паралельна оптимізація (структурні запити)
- [[Inbox/neuro-vault-usage/2026-W17]] — звіт що зафіксував патерн
