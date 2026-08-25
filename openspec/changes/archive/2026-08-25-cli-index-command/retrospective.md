# Retrospective: cli-index-command

> Written: 2026-08-25 (after verify passed)
> Commit range: `71a4d01..3b11600`
> Worktree: /Users/amostovenko/git/neuro-vault/.claude/worktrees/cli-index-command

---

## 0. Evidence

- **Commit range**: `71a4d01..3b11600` (5 commits, pre-archive)
- **Diff size**: +1333 / −33 lines across 12 files (of which code+tests: 5 files, ~278 lines; rest — change artifacts)
- **Tasks done**: 11/12 (4.3 «Open the PR» — за schema-послідовністю PR відкривається після archive; єдиний незакритий чекбокс на момент retro)
- **Active hours**: ~1 (одна сесія: propose → apply → verify)
- **Subagent dispatches**: 7 (2 implementers, 2 task reviewers, 1 final reviewer, 1 fix wave, 1 scoped re-review)
- **New external dependencies**: none
- **Bugs encountered post-merge**: none (pre-merge)
- **OpenSpec validate state at archive**: pass (16/16)
- **Test coverage signal**: vitest 1178 tests / 93 files (було 1164/92); +9 нових тестів у test/config.test.ts + test/cli-index.test.ts

Commit chain (時序):

```
e1cbb1d docs(openspec): plan the cli-index-command change
091a2b9 feat(cli): parse the index subcommand into its own ParsedCli variant
1a9805f feat(cli): index subcommand reconciles the corpus with progress and honest exit codes
6c67639 docs(openspec): tick cli-index-command tasks through gates
3b11600 test(cli): cover index --help short-circuit and terminate TTY progress on fatal
```

---

## 1. Wins

- План ніс повний код (plan.md Tasks 1–2 Step 3) — обидва implementer-и пройшли без жодного fix-раунду на per-task ревʼю (§0: 2 task reviews, 0 rounds); транскрипційні задачі виправдали cheap/mid-tier моделі.
- Wayfinder-мапа закрила всі design-форки до propose — жоден ruling під час apply не знадобився (ledger: 0 `Ruling:` рядків).
- Real-vault прогін (Task 3) покрив саме той шов, який suite свідомо не тестує (default fs-wiring + справжня ONNX-модель): 841/841 embedded / друге виконання 841 reused, exit 0 — рівно сценарії spec-а.
- Pre-flight scan-таблиця з watch item про yargs `.strict()` (ledger, T1 internal) зробила ризик видимим до dispatch-у; ризик не реалізувався, але implementer мав готову інструкцію на випадок реалізації.

## 2. Misses

- 🟡 [evidence: design.md §Risks «New tests assert `index --help` too» vs plan.md Task 1 Step 1] — design пообіцяв тест на `index --help`, а тест-сніпет плану його не містив; implementer чесно транскрибував пропуск, обидва per-task ревʼю його не зловили, спіймав лише final whole-branch review (fix wave `3b11600`). Урок: mitigation-рядки з design.md мають потрапляти в план як явні тест-кейси.
- 📌 [evidence: task-1/2 reports, deviations] — план-сніпети двічі спіткнулись об lint-правила repo (`require-await` на стабі, `no-unsafe-call` на untyped mock params): дрібні, але кожен коштував implementer-у пояснення-девіації.
- 📌 [evidence: tasks.md 4.3 vs verify.md §2] — tasks.md зафіксував порядок «PR → verify → archive», а superpowers-bridge вимагає «verify → retrospective → archive → PR»; розвʼязано на користь схеми, чекбокс 4.3 лишився єдиним незакритим на момент verify.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 1 (stub) | Стаб `runIndexCommand` не-async із `Promise.reject` замість `async … throw` | `@typescript-eslint/require-await` у src/**; сигнатура збережена |
| 2 (cli.ts) | `NeuroVaultStartupDependencies.indexDeps` не додано | План позначив опційним; жоден тест не вимагав — YAGNI |
| 2 (тести) | Типізовані параметри mock-замикань, prettier-формат | `no-unsafe-call` + repo formatting; без зміни асертів |
| 4.3 | PR перенесено після archive | Canonical sequence схеми (PR — останній крок) |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (на етапі propose; рішення імпортовано з wayfinder-мапи, зафіксовано в brainstorm.md) |
| superpowers:writing-plans                        | ✓ |
| superpowers:using-git-worktrees                  | ✓ (EnterWorktree → worktree-cli-index-command) |
| superpowers:subagent-driven-development          | ✓ (7 dispatches, ledger у .superpowers/sdd/plan/) |
| (transitive) superpowers:test-driven-development | ✓ (обидва implementer-и: failing test → fail run → impl → pass) |
| (transitive) superpowers:requesting-code-review  | ✓ (2 per-task + final + scoped re-review) |
| superpowers:finishing-a-development-branch       | ✓ (виконується після archive цим же циклом) |

### Deliberately Skipped Skills

(none — всі рядки ✓)

## 5. Surprises

- yargs per-command `.strict()` відхилив `--no-semantic` на `index` «з коробки» — ручний guard із ambiguity resolution 1 не знадобився (task-1-report, concern 2).
- Холодний індекс 841 нот зайняв 2:47.8 проти оцінки мапи ~1.5 хв на 832 ноти (research 03) — множник ~1.9×; для CLI-обгортки некритично, але оцінку варто оновити перед slice #5 (watcher/фонова індексація її успадковує).

## 6. Promote candidates → long-term learning

- [ ] 🟡 Mitigation-рядок у design.md §Risks — це тест-кейс, а не коментар
  → **Promote to** memory
  > **Why**: «New tests assert `index --help` too» загубився між design.md і план-сніпетом; спіймав лише final review (fix wave 3b11600).
  > **How to apply**: під час writing-plans пройтись по design §Risks/Mitigations і кожен «tests assert X» перекласти в явний тест у сніпеті відповідної задачі.
- [ ] 📌 План-сніпети для src/** мають проходити lint-правила repo, а не лише компілюватись
  → **Promote to** memory
  > **Why**: `require-await` і `no-unsafe-call` двічі змусили implementer-ів девіювати від «verbatim» сніпетів (task-1/2 reports).
  > **How to apply**: пишучи код-сніпети в plan.md, звіряти їх із eslint-конфігом (src/** суворіший за test/**); стаби без await — не-async.
- [ ] 📌 tasks.md delivery-група має слідувати порядку схеми: verify → retrospective → archive → PR
  → **Promote to** memory
  > **Why**: tasks.md 4.3 цього циклу записав «PR → verify → archive» і лишився незакривабельним на момент verify (verify.md §2).
  > **How to apply**: у superpowers-bridge-репо останній таск delivery-групи формулювати як «після retrospective+archive — finishing-a-development-branch (PR)».
