---
date: 2026-06-08
status: accepted
---

# Adopt OpenSpec (superpowers-bridge schema) in neuro-vault

## Problem

neuro-vault already runs the **process axis** of spec-driven development: every
non-trivial change goes brainstorming → writing-plans → subagent-driven-development
→ finishing-a-development-branch (the Superpowers chain), leaving a committed
design spec in `docs/superpowers/specs/` and a local plan in
`docs/superpowers/plans/`. What it lacks is a **spec axis** — a living,
per-capability source of truth that says what each capability does _now_, evolved
by readable requirement-level deltas rather than re-derived from code on every
change.

The vault task _Прокатати OpenSpec на neuro-vault MCP_ frames this
as a deliberate experiment: neuro-vault is the second SDD polygon after the
Moby Dick bot, but the first on a real TypeScript codebase with an accumulated
feature backlog. The open question is sharp because neuro-vault is _not_ a blank
slate — it already has `docs/architecture/` (living, one-concept-per-file
current-state docs) that overlaps with what an OpenSpec spec layer provides. So
the real question is not "spec vs no-spec" but **does a structured capability
spec + delta flow add value over `docs/architecture/` + the Superpowers chain
already in place?**

The reference implementation is `~/git/svadlenka-crm`, which runs the published
[`superpowers-bridge`](https://github.com/JiangWay/openspec-schemas/tree/main/superpowers-bridge)
OpenSpec schema. That schema already solves task item 3 (bridge spec axis ↔
process axis): it is the integration, expressed entirely at the prompt layer.
This change adopts that setup, adapted to neuro-vault's conventions.

## Goals

- Install OpenSpec (`@fission-ai/openspec`) and the `superpowers-bridge` schema,
  mirroring the svadlenka-crm setup.
- Author an `openspec/config.yaml` whose `context` and `rules` encode
  neuro-vault's identity and quality gates (`npm test`, `npm run lint`,
  `npx tsc --noEmit`; the MCP parameter dictionary; the `docs/architecture/`
  update rule).
- Define a coexistence model that places OpenSpec's spec layer alongside the
  existing `docs/architecture/` and `docs/superpowers/` directories without
  duplication or migration churn.
- Add an ADR layer (`docs/adr/`, mirroring svadlenka-crm) as the durable **WHY**
  record, seeded with a bounded set of foundational ADRs that make today's
  implicit load-bearing invariants explicit.
- Stand up routing so future work is correctly classified (opsx change vs direct
  PR) and brainstorm/plan output is redirected into the change directory.
- Capture a thin `baseline` spec — repo invariants only, no whole-codebase
  backfill.
- Leave the framework ready for two pilot changes that exercise OpenSpec in two
  distinct modalities (greenfield capability + delta on an existing one), feeding
  a fit / no-fit decision (task item 4).

## Non-goals

- **Backfilling capability specs for the whole codebase.** That is the "overkill"
  trap the task itself flags. Capability specs are created only as pilots touch
  them.
- **Back-filling per-feature decisions as ADRs.** The ~30 frozen
  `docs/superpowers/specs/` already record those. Only currently-implicit,
  still-load-bearing invariants are seeded as ADRs; everything else accrues going
  forward.
- **Migrating the 30+ existing `docs/superpowers/specs/` design docs or the
  `docs/superpowers/plans/`** into `openspec/`. They are frozen as the
  pre-OpenSpec historical record.
- **Replacing `docs/architecture/`.** The two layers coexist by altitude (see
  Design).
- **Making OpenSpec the mandatory default flow.** Whether it becomes default is
  the _output_ of the pilots, not an input to this change.
- **Running the pilots themselves.** This change stands up the framework; each
  pilot is its own opsx change afterward.

## Design

### What gets installed (mirror of svadlenka-crm)

Already done in the user's `openspec init`:

- `@fission-ai/openspec` dependency (v1.4.1) + `openspec/` scaffold with
  `config.yaml`, `specs/`, `changes/`.
- `openspec/schemas/superpowers-bridge/` copied from the canonical
  `JiangWay/openspec-schemas` (newer than svadlenka's pinned copy — ships the
  `brainstorm.md` and `retrospective.md` templates and `templates/adopters/`).
  `openspec schema validate superpowers-bridge` passes; `openspec schemas` lists
  it as a project schema.

This change adds:

- **`package.json` hygiene**: move `@fission-ai/openspec` to `devDependencies`
  (neuro-vault is a published npm package — the consumer of the MCP server must
  not pull in the spec tooling at runtime), and add a `"spec": "openspec"` script
  (paritied with svadlenka's `pnpm spec`).
- **`openspec/config.yaml`**: set `schema: superpowers-bridge` as the project
  default; author `context` + `rules` (below).
- **`.claude/rules/opsx-routing.md`** and **`.claude/rules/openspec-apply.md`**:
  ported from svadlenka, with gate commands adapted to npm. Routing lives here,
  **not** appended to `CLAUDE.md` — neuro-vault's `CLAUDE.md` is a one-line
  `@AGENTS.md` import, and svadlenka itself keeps routing in `.claude/rules`. The
  schema's `adopters/CLAUDE.md.fragment.md` stays unused (it is the alternative
  for repos without a rules convention).
- **AGENTS.md**: a short "Spec workflow (OpenSpec)" section pointing at
  `docs/workflow.md`, the routing rules, and `docs/adr/INDEX.md`, consistent with
  the existing Workflow section.
- **`docs/workflow.md`**: the end-to-end "idea → merged" flow and the
  five-location table (below), adapted from svadlenka.
- **`docs/adr/`**: `0000-template.md` (MADR-light), `INDEX.md`, and the
  foundational ADR seed (below).
- **`docs/superpowers/specs/README.md`**: a one-screen signpost marking that
  directory as the frozen pre-OpenSpec record and pointing to the live layers.
- **`openspec/specs/baseline/spec.md`**: thin repo-invariant baseline.

### Coexistence model — separation by altitude

neuro-vault carries five doc/spec locations after this change. They do not
overlap because each answers a single, distinct question:

| Location                             | Axis                | Question it answers                                                            | Lifecycle                                        |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| `docs/adr/`                          | **WHY**             | why it is this way, and could it have been otherwise (decision + alternatives) | immutable once Accepted; supersession via Status |
| `docs/architecture/`                 | **HOW**             | how a concept works now (mechanism, prose)                                     | living                                           |
| `openspec/specs/<cap>/`              | **WHAT (current)**  | what a capability must do (SHALL / Scenario, testable)                         | updated on `openspec archive`                    |
| `openspec/changes/<name>/`           | **WHAT (proposed)** | this change's spec delta + brainstorm/design/tasks/plan/verify/retro           | temporary → archived                             |
| `docs/superpowers/specs/` + `plans/` | history             | pre-OpenSpec design+decision records                                           | frozen                                           |

The three live layers each answer a different question, so they don't compete:

- an **ADR** records a _decision_ — "external commands go through `execFile`, not
  `exec`, because shell interpolation is an injection surface" — and is immutable;
- an **architecture doc** _explains the mechanism_ — "`executeRetrieval` runs a
  four-step pipeline; here's how the stages compose";
- a **capability spec** _states the contract_ — "the system SHALL return at most
  `limit` notes; WHEN the threshold yields none AND threshold > 0.3, THEN it
  retries at 0.3."

One is the rationale, one is the narrative a reader follows, one is the checklist
a test asserts. The ~30 frozen `docs/superpowers/specs/` historically blended all
three (problem + design + decision) into one document; going forward that blend is
**split** across the three durable homes, with per-change reasoning living in
`openspec/changes/<name>/design.md`. When a change alters a concept, more than one
layer may update — the spec records the new requirement, the architecture doc the
new explanation, and a load-bearing decision gets an ADR — which `rules.design`
reinforces (and AGENTS.md already requires for `docs/architecture/`).

Because the `superpowers-bridge` schema redirects brainstorm → `changes/<name>/brainstorm.md`
and writing-plans → `changes/<name>/plan.md`, **new opsx changes never write to
`docs/superpowers/`**. The verify step's front-door leak detector warns if design
output lands there by mistake. The old directories simply stop accruing new
files.

> Self-reference: this very change is a direct-PR tooling/bootstrap change, not
> an opsx change (OpenSpec cannot run before it exists; and per the schema's own
> "When NOT to enter the schema" table, build/tooling setup → direct PR). So
> _this_ spec legitimately lands in `docs/superpowers/specs/` — the last one
> before the convention shifts to `openspec/` for capability changes.

### `config.yaml` — context + rules

- **`context`**: what neuro-vault is (an MCP server over an Obsidian vault:
  semantic search + direct vault operations), its architecture invariants
  (ESM + TS strict; errors through `ToolHandlerError`; external commands via
  `execFile` with an args array, never `exec`; one-concept-per-file docs), and a
  pointer to read `docs/architecture/` and the **MCP parameter dictionary**
  (AGENTS.md) before changing any tool's parameters.
- **`rules.design`**: if a change captures a load-bearing architectural decision
  (new runtime/library dependency, change to a core invariant from a prior ADR, a
  close call between competing approaches), propose a numbered
  `docs/adr/NNNN-<slug>.md` alongside the change's design — ask before writing,
  number = next free in `docs/adr/`; if a change alters an architectural concept,
  update/add the matching `docs/architecture/` file in the same change; if it adds
  or renames a tool parameter, conform to the MCP parameter dictionary (a rename
  is a major version).
- **`rules.tasks`**: structure tasks as TDD-friendly units; explicitly mark
  parallel-safe vs sequential groups (the apply phase's
  subagent-driven-development reads this).
- **`rules.verify`**: the three gates that must pass — `npm test`, `npm run lint`,
  `npx tsc --noEmit` — with the note that a `tsup` build alone is insufficient
  (`isolatedModules`; `tsc --noEmit` is the source of truth), mirroring AGENTS.md.

### ADR layer — foundational seed

`docs/adr/` is added with `0000-template.md` (MADR-light: Context / Decision /
Consequences / Alternatives considered) and `INDEX.md` (a table of #, title,
Status), mirroring svadlenka-crm. It is seeded with a bounded set of ADRs that
capture decisions which are load-bearing across many future changes but today live
only implicitly in AGENTS.md and the architecture docs:

1. **0001 — Adopt OpenSpec + superpowers-bridge** (this change; the analog of
   svadlenka's ADR-0005).
2. **0002 — ESM + TypeScript strict; `tsc --noEmit` is the build source of truth**
   (a `tsup` build alone is insufficient under `isolatedModules`).
3. **0003 — Structured tool errors via `ToolHandlerError`** (`{ code, message,
details }` envelope for every MCP client).
4. **0004 — External process invocation via `execFile` with an args array** (never
   `exec` with an interpolated string — injection surface).
5. **0005 — MCP parameter dictionary**: one concept = one parameter name across
   every tool; a rename costs a major version.
6. **0006 — Smart Connections as the read-only embedding corpus** (neuro-vault
   consumes, never writes, Smart Connections data).
7. **0007 — obsidian-cli as the vault write path** (writes go through the CLI, not
   raw file mutation).
8. **0008 — `docs/architecture/` as living per-concept documentation** (one file
   per concept describing current state).

Per-feature decisions are **not** back-filled — the frozen
`docs/superpowers/specs/` already hold them. Each seed ADR is short (the
svadlenka shape: a few paragraphs) and is checked against the codebase as it is
written, not invented.

### Baseline strategy

`openspec/specs/baseline/spec.md` captures only steady-state repo invariants
(ESM/TS-strict, the error-mapping contract, the execFile rule, the three gates,
the release-from-main flow) and an explicit "out of scope of baseline" list that
says every real capability arrives in its own later change. No existing tool gets
a spec until a pilot touches it.

### Pilots (set up here, run later)

Two real backlog tasks, chosen to exercise two different OpenSpec modalities:

- **Greenfield, spec-first**: vault task _Ambient vault context retrieval for
  claudian conversations_ — a capability that does not yet exist in code, so the
  spec is written before any implementation.
- **Evolve existing, via delta**: vault task _Preview-режим тіла для read_notes_ —
  a clean, scoped delta on an existing tool. Preferred over the named "reranker"
  candidate, which is a research spike with no settled requirement — a poor fit
  for a delta flow that assumes a statable contract to evolve.

Each pilot is a separate `/opsx:new <name> --schema superpowers-bridge` change run
through the full artifact chain.

## Sequencing

1. **This change (direct PR)**: package.json hygiene, `config.yaml`,
   `.claude/rules/opsx-*`, AGENTS.md section, `docs/workflow.md`, `docs/adr/`
   (template + INDEX + 0001–0008), `docs/superpowers/specs/README.md` signpost,
   baseline spec. No code behavior change.
2. **Pilot A & B**: each as its own opsx change (brainstorm → … → retrospective →
   archive → PR).
3. **Decision (task item 4)**: after the pilots, a Moby-format fit / no-fit
   reflection with concrete signals → whether OpenSpec becomes the default flow.

## Definition of Done

- `@fission-ai/openspec` is a `devDependency`; `npm run spec --help` works.
- `openspec/config.yaml` sets `schema: superpowers-bridge` and carries the
  neuro-vault `context` + `rules` (design / tasks / verify) above.
- `.claude/rules/opsx-routing.md` and `openspec-apply.md` exist with npm-adapted
  gates; `CLAUDE.md` is unchanged.
- AGENTS.md has a "Spec workflow (OpenSpec)" section linking `docs/workflow.md`,
  the routing rules, and `docs/adr/INDEX.md`; `docs/workflow.md` exists and is
  coherent with it.
- `docs/adr/` exists with `0000-template.md`, `INDEX.md`, and the eight seed ADRs
  (0001–0008); each is accurate against the codebase.
- `docs/superpowers/specs/README.md` signposts the directory as frozen.
- `openspec/specs/baseline/spec.md` exists and is thin (invariants only).
- `openspec validate --all --json` reports valid (or only expected
  no-active-changes state); `openspec schemas` lists `superpowers-bridge`.
- The three gates (`npm test`, `npm run lint`, `npx tsc --noEmit`) pass — this
  change touches only config/docs, so they should be untouched-green.
- Shipped as a direct PR to `main`; not itself an opsx change.

## Risks

- **Redundancy between `docs/architecture/` and `openspec/specs/`.** Mitigation:
  the altitude split (mechanism vs contract) and the config `rules.design` that
  ties them to the same change. The pilots are the real test of whether the split
  holds in practice — if it produces friction without payoff, that is itself the
  no-fit signal the experiment is looking for.
- **Schema drift.** `superpowers-bridge` v1 was authored against OpenSpec 1.3.1;
  we run 1.4.1. Mitigation: `openspec schema validate` passes today; the schema is
  prompt-layer only, so engine minor bumps are low-risk. Re-validate on OpenSpec
  upgrades.
- **Ceremony exceeding risk.** The whole point of the experiment is to find out
  whether the spec axis earns its cost on a project this size. The routing rules'
  "direct PR" table is the pressure valve; the retrospective's Misses section is
  where over-ceremony gets recorded.

## Connections

- Reference setup: `~/git/svadlenka-crm` (`openspec/`, `.claude/rules/opsx-*`,
  `docs/workflow.md`).
- Prior SDD experiment: vault note _Archive/Спробувати OpenSpec на Moby Dick bot_
  (done) — the signal / anti-signal framing the pilots reuse.
- Conceptual basis: the two-axes decomposition in the vault notes _Доповідь — Дві
  осі SDD_ and _We should learn how to SDD_.
- The `superpowers-bridge` schema README (`openspec/schemas/superpowers-bridge/README.md`)
  is the authoritative description of the bridge mechanics this change adopts.
