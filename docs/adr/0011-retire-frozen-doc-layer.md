# ADR-0011 — Four doc altitudes; the frozen pre-OpenSpec record is retired

- **Status**: Accepted
- **Date**: 2026-08-24

## Context

[ADR-0001](0001-spec-workflow-openspec-superpowers.md) adopted OpenSpec on top of the Superpowers skill chain and, in doing so, fixed **five documentation altitudes**: `docs/adr/` (WHY), `docs/architecture/` (HOW), `openspec/specs/` (WHAT now), `openspec/changes/` (WHAT proposed), and `docs/superpowers/specs/` + `plans/` — the **FROZEN** pre-OpenSpec record, declared "readable, not migrated; nothing new is added". Freezing rather than migrating was the right call then: 30+ historical design specs would have cost real effort to port and carried no requirements the new spec axis needed.

Sixteen archived changes later the record is superseded in substance — `openspec/specs/` holds the living contracts and `docs/architecture/` holds the mechanism — but it is not inert. Three separate archived changes record an agent grepping `docs/superpowers/`, recognising it as frozen, and skipping it. That is context spent, every sweep, to learn nothing. Thirty-six files, 1.5 MB.

A second force settled the matter. This repository is public, and it must not name the maintainer's private Obsidian vault. A repo-wide grep found **25 tracked files that did** — personal reflection notes, weekly usage reports, and private task notes cited as provenance. Five of them were inside `docs/superpowers/specs/`; the other twenty were provenance lines under `openspec/changes/archive/`.

## Decision

Delete `docs/superpowers/` entirely. The repo keeps **four** doc altitudes — WHY, HOW, WHAT now, WHAT proposed — and this ADR supersedes the five-altitude map in ADR-0001 §Consequences.

Rewrite every private-vault reference under `openspec/changes/archive/` to neutral provenance ("a private vault task note"). What is immutable in an archived change is the **decision** — what was decided, why, with what consequences. A note title in a "source:" line is provenance metadata, not a decision, and rewording it leaves the record intact.

Leave `docs/adr/0001` and `CHANGELOG.md` byte-identical. An ADR states what was decided *then*; editing it would erase that a five-altitude map was once correct, which is precisely what this ADR exists to record. `CHANGELOG.md` is release history already published into GitHub Releases; five of its links now point at deleted files, and a dead link in a historical release note is a smaller harm than a changelog that no longer matches what shipped.

## Consequences

- **Positive.** Repo-wide documentation sweeps no longer walk a superseded 1.5 MB tree. `docs/README.md` describes four altitudes that all still exist. Tracked private-vault references drop to zero.
- **Negative, and stated plainly.** Scrubbing reduces visibility; it does **not** undo the leak. The note titles remain in git history, in forks, and in anything that has already crawled a public repo. History rewriting was rejected: a public, forked repository cannot be un-published by force-push, and the push would break every clone and PR ref for no privacy gain. The mitigation is prospective — the privacy rule now lives in `docs/agents/issue-tracker.md` and in `openspec/config.yaml` `rules.proposal`, so new artifacts never add to the set.
- **Negative.** Five `CHANGELOG.md` links go dead, including one in the v6 breaking-change entry. Accepted over falsifying published release history.
- **Neutral.** The deleted specs stay recoverable from git history by path; this ADR is the pointer to the removal.
- **Neutral.** `openspec/schemas/superpowers-bridge/` still mentions `docs/superpowers/specs/`. That is vendored upstream documentation describing the Superpowers skill's *default* output path — a general behaviour of the skill, not a claim about this repo. It stays as-is; editing vendored files would fork them against the next upstream bump.
- **Constrains future decisions.** Documentation layout is not a capability. `openspec/specs/baseline/spec.md` already carves it out ("The release process and documentation layout — recorded in `docs/workflow.md`, `docs/README.md`, and ADRs, not as capability requirements"), so a change that only moves doc altitudes has no spec delta to write and therefore no home in the opsx flow, whose `tasks` artifact requires `specs`. **Such a change ships as a direct PR carrying its ADR** — the ADR-level clause in `.claude/rules/opsx-routing.md` routes to opsx only when the ADR accompanies a capability change.

## Alternatives considered

- **Scrub the five leaking files and keep the record.** Leaves the scan cost, which is the actual complaint.
- **Migrate the 36 specs into `openspec/specs/` first.** A migration ADR-0001 already weighed and declined; the content is historical design narrative, not requirements.
- **Amend ADR-0001 in place.** Breaks the repo's own invariant that Accepted ADRs are immutable.
- **Rewrite git history.** See Consequences.
