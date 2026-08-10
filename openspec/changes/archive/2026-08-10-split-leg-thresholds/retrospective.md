# Retrospective: split-leg-thresholds

> Written: 2026-08-10 (after verify passed)
> Commit range: `1eaeb2a..8ca5283`
> Worktree: /Users/amostovenko/git/neuro-vault/.claude/worktrees/split-leg-thresholds (PR #66, ще не merged)

---

## 0. Evidence

- **Commit range**: `1eaeb2a..8ca5283` (8 commits)
- **Diff size**: +1920 / −47 lines across 18 files
- **Tasks done**: 14/14 (`grep -cE '^\s*- \[x\]' tasks.md` → 14)
- **Active hours**: ~1.5 (одна сесія: explore → propose → apply → verify)
- **Subagent dispatches**: 11 (5 implementers, 5 reviewers, 1 fix-wave + scoped re-review)
- **New external dependencies**: none
- **Bugs encountered post-merge**: n/a (PR ще відкритий)
- **OpenSpec validate state at archive**: pass (9/9)
- **Test coverage signal**: vitest 885 → 907 (+22 тести; 75 файлів)

Commit chain (時序):

```
8c30ae1 docs(openspec): add split-leg-thresholds change artifacts
303899a test(semantic): lock default retrieval behavior on a calibration fixture
4fa22d2 fix(semantic): restrict the 0.3 fallback retry to default thresholds
42830d9 feat(semantic): dedicated expansion floor; decouple blocks from user threshold
8cdf5d2 feat(semantic): expansion_floor parameter and semantic_fallback query_stats flag
15c4194 docs: split leg thresholds — expansion_floor, honest threshold, fallback flag
6909b89 docs(openspec): mark split-leg-thresholds tasks complete
8ca5283 fix(semantic): address split-leg-thresholds final-review findings
```

---

## 1. Wins

- [evidence: 303899a → `git diff 303899a HEAD -- test/semantic/calibration-curve.test.ts` append-only] **Baseline-first порядок задач окупився повністю**: повноточні снапшоти дефолтної видачі закомічені до будь-яких змін retrieval і байт-у-байт незмінні через усю гілку — «behavior preservation» доведено механічно, не на словах.
- [evidence: explore-сесія перед propose; brainstorm.md §Code verification] **Код-верифікація діагнозу перед proposal змінила половину scope**: vault-задача стверджувала «інверсію» порогу; читання `retrieval-policy.ts` показало спільний поріг + тихий fallback. Початкові acceptance-критерії були внутрішньо суперечливі (threshold 0.93 одночасно ріже expansion і мусив би давати нуль сідів) — упіймано до написання артефактів, а не в імплементації.
- [evidence: 8ca5283, фінальне ревʼю Important #1] **Whole-branch ревʼю на сильнішій моделі зловило те, що 5 task-ревʼю пропустили**: delta-сценарій вимагав «рівно один» expansion-виживший на floor 0.93, але геометрія фікстури (нижчі сіди бачать вищі сими сусідів) робить кардинальність нездійсненною. Виправлено в спеці до archive — інакше нетестовна вимога синкнулась би в основну спеку.
- [evidence: 8ca5283, test "expansion_floor wiring" — падає при розрізаному wire, перевірено видаленням `expansionFloor,`] **Wire-protection тест**: центральна нова контрактна ниточка (tool → retrieval) тепер має регрес-захист, якого не давав жоден existing-тест.
- [evidence: 5/5 task-ревʼю Approved без жодного fix-раунду] **Плани з повним кодом у брифах** дали нуль ітерацій на задачах 1–5; всі знахідки припали на фінальне ревʼю.

## 2. Misses

- 🟡 [painful | evidence: фінальне ревʼю Important #1 vs spec-фаза] Delta-сценарій із хибною кардинальністю написано в spec-фазі без перевірки проти геометрії фікстури, яку той самий план і визначив — сценарії зі *точними числами* треба звіряти з фікстурою в момент авторства спеки, а не сподіватись на ревʼю.
- 🟡 [painful | evidence: фінальне ревʼю Important #2] SDK-gate тести покрили advertisement + coercion, але не форвардинг параметра всередину — «параметр приймається» і «параметр діє через tool-шар» — це два різні тести, і другий не зʼявився сам собою з планових брифів.
- 📌 [nit | evidence: ledger Task 1/Task 3 minors] Два імплементерські репорти містили неточності (неіснуючий export, завищене покриття) — код правильний, але репорт як single source для наступних задач вимагає перевірки контролером.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Task 3 (calibration acceptance) | Тест «floor 0.93» асертить floor-властивість, не «рівно один» | Геометрія фікстури: сусіди мають вищі сими до нижчих сідів; spec-сценарій приведено у відповідність у fix-хвилі |
| Task 6 (verification) | Виконано контролером без субагента + додано fix-хвилю фінального ревʼю | Task 6 — чиста верифікація без коду; fix-хвиля — стандартний SDD-механізм поза нумерацією плану |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (verbal, в opsx:explore; raw capture у brainstorm.md) |
| superpowers:writing-plans                        | ✓ |
| superpowers:using-git-worktrees                  | ✓ (EnterWorktree) |
| superpowers:subagent-driven-development          | ✓ |
| (transitive) superpowers:test-driven-development | ✓ (TDD у брифах задач 2–4; fail-first задокументовано в репортах) |
| (transitive) superpowers:requesting-code-review  | ✓ (5 task-ревʼю + фінальне whole-branch + scoped re-review) |
| superpowers:finishing-a-development-branch       | ✓ (Option 2 — push + PR #66 за політикою репо) |

### Deliberately Skipped Skills

(порожньо — всі skills використано)

## 5. Surprises

- Поріг, що «фільтрує expansion», насправді доходив і до семантики — його маскував fallback, який спрацьовував лише при *повному* зрізі; всі калібрувальні значення репорту випадково лежали вище всієї смуги, тому часткове фільтрування ніхто не бачив.
- Косинусна геометрія 2D-фікстури має нетривіальний наслідок: сусід, посаджений на сим t до сіда-якоря, має *вищі* сими до інших сідів смуги — саме це зробило spec-сценарій «рівно один» нездійсненним.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Spec-сценарії з точними числами звіряти з тест-фікстурою в момент авторства** → **Promote to memory** (type: feedback)
  > **Why**: delta-сценарій «рівно один виживший на 0.93» був геометрично нездійсненним на фікстурі, визначеній тим самим планом; зловлено лише фінальним ревʼю (8ca5283).
  > **How to apply**: при написанні delta-спеки зі скалярними очікуваннями (кількості, конкретні сими) — прорахувати очікування на фікстурі/геометрії до фіксації сценарію.

- [ ] 🟡 **Для нового контрактного параметра: окремий тест на форвардинг, не лише на схему** → **Promote to memory** (type: feedback, доповнення до test-mcp-via-sdk-gate)
  > **Why**: SDK-gate покрив advertisement/coercion `expansion_floor`, але видалення параметра з викликів retrieval лишало suite зеленим (фінальне ревʼю Important #2).
  > **How to apply**: для кожного нового параметра tool-контракту — тест, що падає при розрізаному wire між tool-шаром і engine/policy-шаром.

- [ ] 📌 **Імплементерські репорти перевіряти перед використанням як контекст наступної задачі** → **One-off** (записано; контролер і так передає інтерфейси сам)
  > **Why**: репорт Task 3 стверджував export приватної константи; якби Task 4 будувався на репорті, а не на контрольованому інтерфейс-блоці, був би compile-fail.
