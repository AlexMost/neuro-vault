<!--
Raw capture. The brainstorming for this change happened asynchronously, in
GitHub issue #93, rather than in a chat session: a user running 15.3.0 arrived
with independent measurements, and the issue body is the resulting decision log.
Captured here as-is (background -> decision chain -> trade-offs) per the
artifact's raw-capture contract. design.md reorganises this; it does not repeat it.

Source: https://github.com/AlexMost/neuro-vault/issues/93
-->

# Brainstorm — conventions-overview-only

## Background

`neuro-vault-mcp` delivers a vault owner's `.neuro-vault/for-external-agents.md`
over two channels, a split recorded in ADR-0010:

1. the **overview channel** — a `conventions` field on the `get_vault_overview`
   response and the `vault://overview` resource, read at call time;
2. the **`instructions` channel** — `buildServerInstructions` composes the same
   text into the MCP `instructions` string once, at startup.

Channel 2 was always labelled best-effort. The question that opened this change
is whether "best-effort" is an honest description of what it delivers.

## The reported symptom

A user reported that a sentence in `README.md` reads as a promise the server
does not keep:

> With several vaults registered ... the `instructions` get one clearly-labelled
> block per vault.

One block per vault is what the server **emits**. It is not what the model
**receives**. Claude Code truncates `instructions` at 2048 characters **per
server**, not per vault, so the first registered vault consumes the budget and
every later block arrives as nothing. The user measured this on 15.3.0 across
two vaults, in both registration orders, with single-vault controls, and the
results reproduce exactly against `buildServerInstructions`.

## The larger problem the numbers exposed

Working the arithmetic through revealed a second failure nobody had looked for.
`buildServerInstructions` emits conventions blocks **first**, then the
699-character server preamble. Conventions-first was a deliberate ADR-0010
ordering decision — put the irreplaceable content where the cut cannot reach it.
The consequence is that the preamble is what the cut reaches instead.

| conventions file | composed `instructions` | conventions delivered | preamble delivered |
| --- | --- | --- | --- |
| 223 | 955 | 100% | yes |
| 1,227 *(current test fixture)* | 1,959 | 100% | yes |
| 2,017 | 2,749 | ~100% | **no** |
| 2,813 | 3,545 | 72% | **no** |
| 6,755 *(the "real file" cited in our own architecture doc)* | 7,487 | **30%** | **no** |

Anything over ~1,316 characters deletes the entire preamble.

## Four findings, stated plainly

**1. The preamble's own comment is conditionally false.** `src/server.ts` says
the preamble is "sized to fit in what is left". That holds only below ~1,316
characters of conventions.

**2. The CI guard is asymmetric.** ADR-0010 says the budget is guarded by a
test. `test/server-instructions.test.ts` guards only the server-authored half,
against a 1,227-character fixture — 89 characters under the ceiling. Adding five
characters to the preamble turns CI red; a vault owner adding 800 characters to
their own file silently deletes the preamble and nobody finds out.

**3. The documented guidance points the wrong way.** Docs offer 8,000 characters
as "the practical budget". That number belongs to `CONVENTIONS_CHAR_CAP` on the
*overview* channel. An owner following the documented guidance guarantees
channel 2 is broken on both sides — no preamble, and most of their own file gone.

**4. There is no signal.** The overview channel flags trimming with
`conventions_truncated`. The `instructions` channel says nothing. That silence is
why diagnosing this took a canary server and six configurations to learn
something the server knew at startup.

## Decision chain

### Q1 — patch the channel, or cut it?

**Cut it.**

Patching means, at minimum: a startup budget warning, budget-aware multi-vault
composition that divides 2048 fairly across N vaults, a truncation signal on a
channel that has no response shape to carry one, and a re-ordering rule that
stops the preamble being the thing that dies. Each is real work on a channel
whose value has never been measured.

### Q2 — is cutting a reversal of ADR-0010?

**No — it is ADR-0010 applied consistently.**

ADR-0010 says `instructions` carries only what no tool description can carry.
Conventions went in under "no description can supply another vault's rules" —
true of the **text**, false of the **pointer**. `get_vault_overview`'s
description already carries that pointer today.

The duplication was accepted for the sake of a hypothetical client that renders
`instructions` uncapped. The same ADR records that Cursor and Windsurf were
never measured. We are paying a measured cost for an unmeasured benefit.

### Q3 — what does cutting buy?

In one move it removes:

- the dead preamble above ~1,316 characters,
- the multi-vault first-come-takes-all,
- the misleading README sentence — deleted rather than rewritten,
- the need for a startup budget warning,
- the need for budget-aware multi-vault composition.

`buildServerInstructions` stops being async and stops needing the registry. It
becomes a constant.

### Q4 — what does it cost?

An owner who relies today on conventions reaching the system prompt **without a
tool call** loses that.

Mitigation: the pointer line, plus the fact that this path already delivers
nothing to sub-agents, nothing past ~1,316 characters, and nothing at all to any
vault after the first. The population that loses something real is: single-vault
owners, with a file under ~1,316 characters, on a client that renders
`instructions`, in a main agent rather than a sub-agent.

### Q5 — does the overview channel change?

**No.** `readVaultConventions`, `capConventions`, `CONVENTIONS_CHAR_CAP`,
`IVaultEntry.readConventions`, the `conventions` / `conventions_truncated`
fields, and `vault://overview` are all untouched. This change removes one
consumer of `readConventions` (`server.ts`); the two that matter
(`get_vault_overview`, the `vault://overview` resource) keep it load-bearing.

### Q6 — does the freed budget get spent?

**No.** Removing conventions frees ~1,300 characters of the 2048. The preamble
is not grown to fill it. Anything a tool can say about itself still belongs on
that tool's description — that is ADR-0010 and this change does not weaken it.
Headroom is the point, not an allowance.

### Q7 — new ADR, or amend ADR-0010?

**New ADR-0012, building on ADR-0010.** ADRs are immutable (ADR-0008).
ADR-0012 records that duplicating owner content into `instructions` measured
net-negative, and why the pointer is sufficient where the text was not.

## Design trade-offs accepted

- **Losing the no-tool-call path.** Accepted: it is conditional on client,
  vault count, file size, and agent kind, and it is undetectable when it fails.
  A pointer that always arrives beats text that usually does not.
- **Deleting the README sentence rather than rewriting it.** There is no honest
  rewrite of "one block per vault" — the accurate version describes a behaviour
  we are removing.
- **Keeping `CONVENTIONS_CHAR_CAP` at 8,000.** It was always the overview
  channel's cap. The bug was documenting it as `instructions` guidance; once
  `instructions` no longer carries conventions, 8,000 is simply correct and
  needs no note.
- **Collapsing the test suite rather than porting it.** The 2048-character
  budget suite becomes "instructions are a constant, under the cap". Multi-vault
  block-attribution tests go away with the behaviour they described.

## Documentation footnote from the same report

In Claude Code, `/mcp reconnect` does **not** rebuild the session's system
prompt — changed `instructions` appear only in a fresh session. Worth stating in
the docs so the next person verifying an `instructions` change by reconnecting
does not report a false negative.

## Credit

Reported with independent measurements by a user running 15.3.0.
