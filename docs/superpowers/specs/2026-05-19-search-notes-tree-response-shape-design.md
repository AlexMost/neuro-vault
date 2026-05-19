# `search_notes` tree response shape

Перевести response `search_notes` у tree-форму, де нота — це вузол, а її `blocks[]` і expansion-сусіди (`related[]`) — листя. Усуває два структурні баги поточної плоскої форми: сплутування query-similarity з expansion-similarity, і втрату звʼязку "сусід → конкретна нота".

Споріднений запис у вауті: [[Tasks/neuro-vault — search_notes tree response shape]] — джерело цього спеку.

## Проблема

Поточна форма response плоска: top-level `results[]` плюс паралельний `blockResults[]`. Expansion-сусіди змішані в `results[]` з прапором `via_expansion: true` і полем `similarity`, яке насправді **expansion-similarity** (до іншої ноти, не до запиту).

Дві окремі структурні проблеми:

1. **`similarity` у expansion-результатах — з іншої шкали**, але виглядає як query-similarity. Модель бачить 0.936 і трактує як "найбільш релевантний результат" — а це лише сусід якогось seed-результату.
2. **Сусідство — парна властивість**, не одиночна. Експансія-сусід належить конкретній seed-ноті, але поточна форма виражає це лише текстовим полем `expanded_from`, яке вимагає від моделі зшивати масиви вручну. Те саме з `blockResults`: блок належить ноті, але лежить паралельним списком на топ-рівні.

## Запропоноване рішення — дерево, нота як вузол

Кожна нота-результат стає вузлом дерева. У неї вкладаються:

- `blocks[]` — block-level matches саме з цієї ноти.
- `related[]` — expansion-сусіди саме цієї ноти.

### Приклад відповіді (single query, deep mode)

```json
{
  "results": [
    {
      "path": "Tasks/EVO — roadmap...",
      "similarity": 0.773,
      "backlink_count": 0,
      "vault": "Obsidian",
      "blocks": [
        {
          "heading": "...#Phase 1 — Demo moment у команді",
          "lines": [25, 29],
          "similarity": 0.825
        }
      ],
      "related": [{ "path": "Resources/Онтологія.md", "expansion_similarity": 0.936 }]
    },
    {
      "path": "Tasks/catalog-ui — ...",
      "similarity": 0.721,
      "backlink_count": 2,
      "vault": "Obsidian",
      "blocks": [],
      "related": [
        { "path": "Resources/Онтологія.md", "expansion_similarity": 0.812 },
        { "path": "Tasks/EVO — roadmap...", "expansion_similarity": 0.704 }
      ]
    }
  ]
}
```

### Приклад відповіді (multi-query, deep)

```json
{
  "results": [
    {
      "path": "Tasks/EVO — roadmap...",
      "similarity": 0.773,
      "matched_queries": ["agentic-flow demo"],
      "backlink_count": 0,
      "vault": "Obsidian",
      "blocks": [...],
      "related": [...]
    }
  ],
  "truncated": false
}
```

## Чому ця форма

1. **Шкала score-у вирішується структурно.** У direct-вузлі — `similarity` (query-similarity). У `related`-елементі — `expansion_similarity` (note-to-note). Різні ключі = різні шкали; модель не плутає.
2. **`blockResults` природно вкладаються.** Блок належить ноті, не запиту; паралельний список заважав читати.
3. **Pruning локальний.** Модель вирішує "ця нота нерелевантна" і одним рішенням ігнорує її `blocks` і `related`.
4. **Token budget читається по нотах.** "Прочитаю топ-3 ноти з усім контекстом" — це одна гілка дерева, а не три фільтри по паралельних масивах.

## Дедуплікація: дублюємо

Якщо expansion-сусід `Resources/X` семантично близький до двох direct-вузлів — **зʼявляється у `related[]` обох** (з відповідним `expansion_similarity` до кожного). Структурна чесність важливіша за економію токенів.

Аргументи за дублювання:

- **Семантично правильно.** Сусідство — парна властивість; той самий вузол може бути сусідом кількох seed-ів. Притискання до одного parent — це домовленість, яка викидає інформацію.
- **Просто реалізувати.** Сервер для кожного direct-результату незалежно рахує своїх сусідів — нема глобального merge-кроку з вибором "правильного" батька.
- **Token cost помірний.** `{path, expansion_similarity}` ≈ 30-50 токенів. Дублі в межах одного response — не катастрофа.

## Глибина дерева

**Depth = 2** (запит → нота → `{blocks, related}`). Експансія-від-експансії не йдемо. Якщо моделі треба копати — окремий виклик `get_similar_notes` по конкретній ноті.

## Поведінкові інваріанти

| Інваріант                                                                    | Деталі                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `similarity` живе тільки в direct-вузлах.                                    | Query-similarity. У `related`-елементах ніколи.                      |
| `expansion_similarity` живе тільки в `related[]` елементах.                  | Note-to-note. У direct-вузлах ніколи.                                |
| `blocks[]` завжди present на direct-вузлах.                                  | Порожній масив, якщо матчів немає. Уникає edge-case-ів у consumer-а. |
| `related[]` завжди present на direct-вузлах.                                 | Порожній масив у `quick` mode і коли expansion нічого не знайшов.    |
| Блок ноти A ніколи не з'являється в `blocks[]` ноти B.                       | Блоки строго належать своїй ноті.                                    |
| Той самий `path` може з'явитися в `related[]` кількох direct-вузлів.         | Це навмисно — див. дедуплікацію.                                     |
| `related[]` не вкладається в інші `related[]`.                               | Depth = 2.                                                           |
| `blocks[]` сортуються `similarity` desc, потім по `path`/lines.              | Як у поточному merge.                                                |
| `related[]` сортується `expansion_similarity` desc, tie-break по `path` asc. | Як у поточному `computeExpansion`.                                   |

## Прапор `via_expansion` прибрано

Структура сама комунікує: елемент в `related[]` — expansion-сусід, елемент в `results[]` — direct. Прапор зайвий.

## Скоуп блоків у deep — orphan'и drop

**Рішення:** блоки строго scope-ляться до nodes, що пройшли в `results[]`. Якщо в deep mode block-search над цілим корпусом знайшов гарний блок ноти, що не пройшла в note-level top-K — блок ігнорується.

Чому не промоутити такі ноти у `results[]`:

- Promoтнута нота не має query-similarity на note-level (тільки на block-level) — мішає визначеність шкали `similarity`.
- 90% корисних випадків покриті: нота з сильним блоком зазвичай і так у note-level top-K при тих самих threshold-ах.
- Якщо реальний use case на втрату важливої ноти зʼявиться — буде окрема таска "promote notes with strong block matches".

Це **зміна поведінки**: зараз у deep можна побачити `blockResults[]` запис, що належить ноті поза `results[]`. У новій формі — ні. Документується одним рядком у CHANGELOG.

## `expansionLimit` стає per-note cap

Поточна семантика: `expansionLimit: 3` — глобальний cap (після merge bestByPath) на загальну кількість expansion-результатів.

Нова семантика: **per-note cap на `related[]`** кожного direct-вузла. Default той же — `3`. Тобто кожна нота отримує до 3 найкращих сусідів. Загальна кількість expansion-сусідів у response ≤ `notes × 3`, але з ймовірним дублюванням.

Якщо це створить занадто широкі відповіді — окрема таска з тюнінгом.

## Сумісність

Не парасолимо. Шиплимо чисту форму одразу — без compat-шару, deprecation-period, `format: "tree"` опції. Зміна потрапляє в release як **MAJOR** bump (response shape — публічна частина API).

## Зміни в коді — orientation

Деталі — в плані. Тут точки, які треба буде зачепити, щоб spec можна було тримати в голові цілком:

- `src/modules/semantic/retrieval-policy.ts` — `RetrievalOutput` і `MultiRetrievalOutput` змінюють форму. `computeExpansion` повертає **per-seed** map замість глобально дедупліцьованого списку.
- `src/modules/semantic/tools/search-notes.ts` — складання відповіді переписується (об'єднати blocks/related під ноти); прибрати `blockResults` на топ-рівні; оновити tool description.
- `src/modules/semantic/types.ts` — нові типи `NoteResultNode`, `RelatedNote`; `SearchResult`/`MultiSearchResult` чи їхні replacements більше не мають `via_expansion`.
- `src/server.ts:124` — згадка `blockResults` у server description.
- `README.md` — приклад нової форми, оновити фрагмент про expansion.

## Definition of Done

- [ ] Response має tree-форму: `results[]` з вкладеними `blocks[]` і `related[]` на кожному direct-вузлі.
- [ ] Топ-рівневий `blockResults` прибрано.
- [ ] Прапор `via_expansion` прибрано. Структура сама комунікує.
- [ ] У direct-вузлах — поле `similarity`. У `related[]` items — `expansion_similarity`. Поля ніколи не співіснують в одному об'єкті.
- [ ] Один і той же expansion-сусід може зʼявитися в `related[]` кількох parent-нот (дублювання дозволене, навмисно).
- [ ] `blocks[]` і `related[]` завжди present на direct-вузлах (порожній масив, якщо немає).
- [ ] Block ноти A не з'являється в `blocks[]` ноти B.
- [ ] У deep mode orphan-блоки (з нот, що не пройшли в `results[]`) ігноруються.
- [ ] `expansionLimit` — per-note cap (default 3).
- [ ] Tool description у MCP оновлений: секція про tree, про `related` як сусідів конкретної ноти, про шкали `similarity` vs `expansion_similarity`. Старі згадки `blockResults` / `via_expansion` зняті.
- [ ] `server.ts` description: згадка `blockResults` оновлена/прибрана.
- [ ] README оновлений з прикладом нової форми.
- [ ] CHANGELOG: один абзац про нову форму, без migration-секції. Реліз — MAJOR.
- [ ] Тести в `test/semantic/retrieval-policy.test.ts` і `test/semantic/tools/search-notes*.test.ts` оновлені під нову форму; покриття інваріантів вище.
- [ ] `npm test`, `npm run lint`, `npx tsc --noEmit` — green.

## Test plan

- **Quick, single query:** результати мають `similarity`, `blocks[]` (scope-нуто до matched notes), `related: []`.
- **Quick, multi query:** як вище + `matched_queries`, `truncated`.
- **Deep, single query:** кожна нота має `similarity`, `blocks[]`, `related[]` (≤ per-note cap).
- **Deep, multi query:** як вище + `matched_queries`, `truncated`.
- **Жоден `related[]` елемент не має `similarity`** — тільки `expansion_similarity`. Перевірка на типовому фікстюрі.
- **Дублювання `related`:** фікстюра, де expansion-сусід близький до двох seed-ів, → з'являється в `related[]` обох з власним `expansion_similarity` до кожного. Цей кейс має покриватися явним тестом.
- **Blocks scoping:** block, що належить ноті A, не присутній в `blocks[]` жодної іншої ноти.
- **Orphan-блоки в deep:** фікстюра з блоком, чия нота поза note-level top-K, → блок не з'являється в response.
- **`expansionLimit` per-note cap:** з seed-ів з ≥5 потенційними сусідами кожен → `related[]` ≤ 3.
- **`backlink_count`, `vault`, `matched_queries`** — на тих самих рівнях, що й раніше (direct nodes).
- **Сортування** `blocks[]` і `related[]` стабільне (similarity desc, потім path/lines).

## Out of scope

- Експансія-від-експансії (depth > 2).
- Promotion-ноти з сильними block-матчами в `results[]`. Окрема таска, якщо реальний use case зʼявиться.
- Опція `include_related: false` — дублює `mode` (quick = без expansion).
- Зміни в логіці самого expansion (як обираються сусіди, з яким threshold).
- Path filters і threshold tuning — окрема таска [[neuro-vault — search_notes path filters]] / спец [`2026-05-19-search-notes-path-filters-design.md`](2026-05-19-search-notes-path-filters-design.md).

## Звʼязки

- [[Reflections/2026-05-19 — demo as un-knowing]] — debrief сесії, з якої виник цей запит (через мета-аналіз retrieval-якості).
- [[Tasks/neuro-vault — search_notes tree response shape]] — джерело-задача у вауті.
- [`2026-04-27-search-notes-clarity-design.md`](2026-04-27-search-notes-clarity-design.md) — попередній рівень упорядкування response.
- [`2026-05-19-search-notes-path-filters-design.md`](2026-05-19-search-notes-path-filters-design.md) — суміжна precision-таска у тому ж тулі.
