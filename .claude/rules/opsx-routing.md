# Workflow routing — opsx (OpenSpec + Superpowers bridge)

This repo uses [`superpowers-bridge`](https://github.com/JiangWay/openspec-schemas/tree/main/superpowers-bridge) at `openspec/schemas/superpowers-bridge/`. Artifacts live in `openspec/changes/<name>/`: brainstorm → proposal → design → specs → tasks → plan → verify → retrospective. Apply phase uses git worktrees + `superpowers:subagent-driven-development` (transitively brings TDD + per-task code review).

## Entry routing

| Trigger                                                          | What to do                                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User starts a narrative "design discussion / let's brainstorm"   | Run verbal `superpowers:brainstorming` in-chat. Do NOT write to `docs/superpowers/specs/` (frozen). Once the 5 promotion criteria below hold, suggest `/opsx:propose` |
| User invokes `/opsx:new` / `/opsx:ff` / `/opsx:propose` directly | Follow the schema's flow; artifact instructions inject at each step                                                                                                   |
| User explicitly says bug fix / typo / config tweak / doc update  | Direct PR — do NOT open an opsx change                                                                                                                                |
| User is mid-change                                               | Advance with `/opsx:continue`, `/opsx:apply`, `/opsx:verify`, `/opsx:archive`                                                                                         |

## When NOT to use opsx (direct PR)

| Scenario                                                                                                                                | Direct PR?   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| New feature, new capability, new/changed tool contract, breaking change                                                                 | ❌ Use opsx  |
| Bug fix without contract change, test backfill, lint/format tweak, non-breaking dep bump, typo, docs, config value tweak, tooling setup | ✅ Direct PR |

Principle: process ceremony scales with risk. New/changed **tool contracts** (input schema, output shape, MCP parameter dictionary, error codes), new capabilities, ADR-level decisions → opsx. Otherwise → direct PR.

## Verbal brainstorm → opsx promotion criteria

All 5 must hold before promoting (any missing → keep brainstorming):

1. **Scope locked** — one sentence describes what's in / out
2. **Major design forks resolved** — alternatives weighed; remaining TBDs have an owner and impact-scope statement
3. **Cross-system dependencies mapped** — ready / mockable / genuinely unknown — pick one per dep
4. **Acceptance criteria stateable** — concrete pass conditions (e.g., `npm test && npm run lint && npx tsc --noEmit` pass + N deliverables)
5. **Conversation converging** — recent turns are confirmations, not new alternatives

When all 5 hold → proactively suggest "ready to `/opsx:propose`?" — wait for user ack. Never auto-trigger.

## Front-door anti-patterns

- Letting brainstorming write to `docs/superpowers/specs/` — that directory is frozen; output belongs in `openspec/changes/<name>/brainstorm.md`
- Letting writing-plans write to `docs/superpowers/plans/` — output belongs in `openspec/changes/<name>/plan.md`
- Promoting to opsx with unresolved blocking TBDs
- Opening an opsx change for bug fix / typo / config tweak / tooling setup

Full details: [bridge README §Entry & exit gates](https://github.com/JiangWay/openspec-schemas/blob/main/superpowers-bridge/README.md#entry--exit-gates). Layer map: [`docs/workflow.md`](../../docs/workflow.md).
