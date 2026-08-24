# ADR-0012 — Vault conventions leave the `instructions` channel

- **Status**: Accepted
- **Date**: 2026-08-24

## Context

[ADR-0010](0010-context-delivery-channels.md) established that tool descriptions and tool responses are the two channels that reach an agent intact, and that MCP `instructions` is best-effort: populated, ordered so the most irreplaceable content leads, never load-bearing. Under that rule a vault owner's `.neuro-vault/for-external-agents.md` was routed down **two** channels at once:

- the **overview channel** — a `conventions` field on the `get_vault_overview` response and the `vault://overview` resource, read fresh at call time;
- the **`instructions` channel** — `buildServerInstructions(registry)` read every registered vault's file at startup and emitted one block per vault, ahead of the 693-character server preamble.

The duplication was accepted deliberately, on the theory that a client rendering `instructions` uncapped would get the conventions with no tool call. ADR-0010 records that Cursor and Windsurf were never measured.

Measuring the channel on 15.3.0 showed what actually arrives. Claude Code truncates `instructions` at 2048 characters **per server**, and because conventions were emitted first, the cut landed on the preamble:

| conventions file | composed `instructions` | conventions delivered | preamble delivered |
| --- | --- | --- | --- |
| 223 | 955 | 100% | yes |
| 1,227 *(then the test fixture)* | 1,959 | 100% | yes |
| 2,017 | 2,749 | ~100% | **no** |
| 2,813 | 3,545 | 72% | **no** |
| 6,755 | 7,487 | **30%** | **no** |

Four findings shaped the decision:

1. **The cap is per server, not per vault.** With two vaults registered, the first consumes the budget and every later block arrives as nothing — reproduced in both registration orders.
2. **The preamble died first.** Conventions-first ordering meant anything over roughly 1,316 characters of conventions deleted the preamble entirely, contradicting the comment in `src/server.ts` that claimed it was "sized to fit in what is left".
3. **The CI guard was asymmetric.** `test/server-instructions.test.ts` pinned the conventions fixture at 1,227 characters and varied only the preamble. The vault owner's file was the free variable in production and the pinned constant in CI — which is how this shipped.
4. **There was no truncation signal.** The overview channel flags trimming with `conventions_truncated`; `instructions` has no response shape to carry one, so every failure above was silent.

Our own documentation compounded it, offering 8,000 characters as the practical budget. That is `CONVENTIONS_CHAR_CAP`, and it belongs to the *overview* channel.

## Decision

Cut the conventions out of `instructions` rather than patch the channel. `buildServerInstructions(registry)` becomes `SERVER_INSTRUCTIONS`, an exported string constant: the existing preamble plus a one-paragraph pointer naming `get_vault_overview`, stating that conventions arrive there rather than here, and saying to call it before reading or writing notes. No vault file is read at startup. The composed string is identical for every registry and measures 936 characters — 54% under the cap, with no dependence on vault count, vault names, registration order, or any file on disk.

The overview channel is untouched: `conventions`, `conventions_truncated`, call-time freshness, fan-out attribution, and the 8,000-character `CONVENTIONS_CHAR_CAP` all keep their current behaviour.

**This applies ADR-0010 rather than reversing it.** ADR-0010 says `instructions` carries only what no tool description can carry. Conventions entered under "no description can supply another vault's rules" — true of the *text*, false of the *pointer*, and `get_vault_overview`'s description already carries that pointer today. The duplication was accepted for a hypothetical client that renders `instructions` uncapped; the same ADR records that Cursor and Windsurf were never measured. We were paying a measured cost for an unmeasured benefit. ADR-0010 stands as written and is not amended — ADRs are immutable ([ADR-0008](0008-architecture-living-docs.md)).

## Consequences

- **Five problems go away in one move.** The dead preamble, the multi-vault first-come-takes-all, the README sentence promising "one clearly-labelled block per vault", the need for a startup budget warning, and the need for budget-aware multi-vault composition all disappear with the behaviour that created them.
- **The budget invariant gets stronger.** The test no longer asks whether a representative fixture fits; it asserts the string is a constant beneath 2048 characters. No vault owner's action can break it, and preamble growth is now visible in a diff to a literal rather than hidden inside a composition.
- **An owner relying on conventions reaching the system prompt without a tool call loses that path.** Accepted. It was already conditional on four things holding at once — a client that renders `instructions`, a single registered vault, a file under ~1,316 characters, and a main agent rather than a sub-agent — and it failed silently whenever any one did not. A pointer that always arrives is worth more than text that usually does not.
- **The agent might not call `get_vault_overview`.** Mitigated by three independent nudges over the two reliable channels: the pointer names the tool and the trigger, the preamble's scope-discovery paragraph already routes to `get_vault_overview` first, and the tool's own description states that its response carries authoritative conventions.
- **An unmeasured client that renders `instructions` in full would see a regression.** Accepted knowingly — it is the same unmeasured hypothetical that justified the duplication originally, except the cost is now measured and the benefit still is not. If such a client is confirmed, conventions can be reinstated behind client-aware composition, with data to size it against.
- **The freed ~1,300 characters are headroom, not an allowance.** The preamble is not grown to fill them. Anything a tool can say about itself still belongs on that tool's `description`; ADR-0010's rule is being enforced here, not relaxed.
- **`readVaultConventions`, `capConventions`, and `CONVENTIONS_CHAR_CAP` are unchanged**, as is `IVaultEntry.readConventions` — all still load-bearing for `get_vault_overview` and the `vault://overview` resource. Only the `src/server.ts` consumer goes away.
- **Verifying a change to `instructions` needs a fresh session.** In Claude Code, `/mcp reconnect` reconnects the server but does not rebuild the session's system prompt, so the old string stays in place and the change reads as a false negative.

## Alternatives considered

- **Emit only the first vault's conventions, budget-checked** — still silent when it trims, still leaves later vaults with nothing, and still makes the preamble's survival depend on a file the server does not control.
- **Reverse the order, preamble first and conventions after** — saves the preamble and dooms the conventions instead; trades one silent loss for another.
- **Warn on stderr at startup when the composed string exceeds 2048 characters** — surfaces the problem without fixing it, and stderr is not where a vault owner looks.
