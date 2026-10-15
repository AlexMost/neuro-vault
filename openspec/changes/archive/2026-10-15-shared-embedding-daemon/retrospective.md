# Retrospective: shared-embedding-daemon

> Written: 2026-10-15, after verify passed with warnings (`verify.md`).
> Commit range of this cycle (PR 2): `7d96dbf..HEAD`. PR 1 merged earlier as #147 (`7d96dbf`).
> Worktree: `.claude/worktrees/shared-daemon-pr2-6aff26`, branch `claude/shared-daemon-pr2-6aff26`.

This retro covers PR 2, the second and last PR. PR 1's lessons reached this cycle as rulings, through the brief the parent session wrote: a build-keyed key, `ensurePrivateSocketDir` before connect, client status on the first non-`daemon.*` request, a socket close as a connection error, the deprecated `isJSONRPCResponse`, and the `--idle-timeout` cap. Where a finding is about the change as a whole, it says so.

---

## 0. Evidence

- **Commit range (PR 2)**: `7d96dbf..HEAD`: 3 `feat`, 2 `fix` (both found in review), 1 `docs`, then the verify/retro/archive commit.
- **Diff size (PR 2, code and docs before the close-out)**: 31 files, +2235 / −89.
- **Tasks done**: 22/23 when this retro was written. 2.10 is the close-out in progress.
- **Active hours**: one session of about 2 h. About 40 min of that was the manual checks and measurements over real stdio servers. The 30-minute idle-exit observation ran in the background.
- **Subagent dispatches**:
  - 0 implementer dispatches: the controller implemented Tasks 13–16 inline (see §4).
  - 2 review dispatches: Tasks 13–14, then the wiring, the first fix and the docs. Each found one Important defect, and both were fixed (`7d3d07d`, `bf54098`).
  - 1 verify-mapping agent (Sonnet).
  - 1 research agent, on the owner's mid-cycle question about ready-made daemon libraries.
- **New external dependencies**: none, in either PR.
- **Bugs encountered post-merge**: not merged yet.
- **OpenSpec validate state at archive**: 20/20 pass before archive.
- **Test coverage signal**: 1804 passed / 4 skipped, against 1743 / 4 on `main`, so +61 tests. Three new test files plus a rewritten `provider-factory.test.ts`; one of the new files is a real-socket integration test of the facade against PR 1's server. 54 scenarios: 45 covered, 9 partial, none uncovered (`verify.md` §4).

Commit chain:

```
827b803 feat(semantic): daemon connection — locate, spawn, poll, request            [2.1]
4239310 feat(semantic): daemon-backed embedding provider with one-way fallback       [2.2, 2.3]
0db3f1c feat(semantic): embed through the shared daemon by default; --no-shared …    [2.4–2.6]
7d3d07d fix(semantic): never reconnect inside a daemon request                       [review fix]
e573827 docs: shared embedding daemon — guide, architecture, facade                  [2.9]
bf54098 fix(semantic): never respawn a daemon from a CLI script rebuilt under the session [review fix]
```

---

## 1. Wins

- **The memory goal is met, with numbers.** Three concurrent sessions take ≈ 1.27 GB with the daemon against 2.40–2.55 GB without it. An `index` run next to a server peaks at 121 MB instead of 974 MB (`verify.md` §8). The issue's premise was 450–600 MB per session. A session holding no model is about 130 MB.
- **Latency improved instead of regressing.** p95 is 159 ms shared against 220 ms in-process, measured over 90 concurrent calls. One model means less CPU contention than three, so the JSON vector cost the design worried about (D2) does not show.
- **The brief's PR 1 deltas all landed on the first pass.** Each one is pinned by a named test:
  - socket directory checked before connect;
  - `embed.initialize` first on each connection;
  - socket close as `DaemonConnectionError`;
  - `daemon.log` unopenable leads to the fallback (Review Focus 5);
  - `isJSONRPCResultResponse`.
- **Review earned its keep, twice.** Each review found one Important defect that no test and no manual check had surfaced: the skipped handshake, and the upgrade respawn (§2). Both were fixed, with tests, before archive. The second was also replayed for real (verify 2.7 #8).
- **The manual checks used real processes.** A throwaway MCP driver ran real stdio servers over real sockets: spawn, respawn after `daemon stop`, rebuild into a second daemon, the `.ts` fallback line, `--no-shared`. It exercised the exact code a Claude Code session runs, without touching the owner's live install.

## 2. Misses

- 🟡 **The handshake could be skipped. It shipped in `4239310` and was caught only by review.** `DaemonConnection.request()` reconnected on its own, so a call landing between a framing error and the socket's `close` event wrote `embed.query` on a fresh connection, without `embed.initialize`. On a cold daemon the model load would then have run inside the 60 s query timeout. The fix (`7d3d07d`) makes `request()` never connect. The plan's own snippet had the same shape (`request` → `ensure`), and nobody re-checked it once the per-connection handshake was added.
- 🟡 **Task 13 was written implementation-first.** The `DaemonConnection` code came before its 26 tests. The tests then found two real defects (`close()` not forgetting the socket synchronously; an `error` emitted before a listener), so they were not a formality. But the red step never ran.
- 📌 **Scripted multi-line edits failed twice after `eslint --fix` / `prettier` reflowed a test file.** One case was a removed `!`, the other re-wrapped lines. Each failure cost a round trip. Re-reading the region, or anchoring the edit on the current text, avoids it.
- 📌 **Two measurement confounds in the driver.**
  - "Ready" first meant "not an error", which counted lexical-only answers during indexing.
  - A second scratch cache directory still reached the first build's daemon, because the socket path does not depend on the cache dir.
  - Both were caught by inconsistent numbers, then documented: `shared-daemon.md` now states the second.

- 🔴→fixed **The upgrade path was wrong in code and in the docs. It shipped in `0db3f1c` + `e573827` and was caught by the second review.**
  - **The failure.** A session keys its daemon by the CLI script's size and mtime at startup. After an upgrade or rebuild, if that daemon went away, the session spawned the *new* script. The new daemon keyed itself on another socket, so the session polled the wrong one for 10 s and then fell back.
  - **The docs made it worse.** The guide recommended `daemon stop` after an upgrade, which triggers exactly this.
  - **Why it matters.** The owner's global install is a symlink into the repo, so every `npm run build` is such an "upgrade". This would have bitten on day one.
  - **The fix.** `bf54098` re-stats the script before every spawn.
  - **Why it was missed.** The design's Risk "a symlinked dev install rebuilds without a version bump" was mitigated for *new* sessions (a new key) only. The old session's respawn path was never walked through. The rebuild manual check (2.7 #4) closed its sessions instead of stopping the daemon under them.

## 3. Plan deviations

- **`request()` never connects** (plan Task 13 had `request` → `ensure`). See §2. `ensure()` also drops a socket that is destroyed or ended but not yet closed.
- **Per-connection `embed.initialize` handshake.** The plan's facade sent `embed.initialize` only from `initialize()`. The brief required it right after connecting, so the facade tracks `DaemonConnection.epoch`.
- **Additions beyond the plan, for robustness:**
  - a 2 s connect timeout (an ambiguous connect counts as unavailable, never as a spawn);
  - an asynchronous spawn `error` ends the poll early;
  - the socket is `ref`'d only while a request is pending, so a finished `index` run or a hung-up server exits;
  - document batches are chunked to the daemon's `max_batch_size`.
- **Factory shape.** Instead of fixed `env/home/uid/platform` defaults wired inline, the factory takes:
  - `build` (stat injection) and `io` (the connection's I/O), for tests;
  - a CLI it cannot stat yields a facade whose first call falls back, rather than a throw at startup;
  - `uid` from `process.getuid?.() ?? -1`, never `os.userInfo()` (brief).
- **`daemonProviderFor` exported from `cli-daemon.ts`.** Task 2.6 was already wired in PR 1, but nothing pinned that the daemon's providers are in-process. A facade there would spawn itself, so a test now pins it.
- **The `daemon` command's help text changed** from PR 1's "not on demand" assertion to "the server and `index` start it on demand". The PR 1 test asserted the old truth.
- **Two spawn guards not in the plan, from the second review.** The script's build is re-checked before every spawn (`bf54098`, §2), and the daemon's cwd is the home directory. The delta spec gained the "Upgraded under an open session" scenario, and the fallback line names the log only when there is one.
- **`cli.ts` passes `cliPath` to the daemon command too**, so all three commands key by one resolved path.

## 4. Skill / workflow compliance

| Skill | Used? | Notes |
| --- | --- | --- |
| `opsx:apply` | ✓ | Tasks 2.1–2.10 in order; checkboxes updated per commit |
| `superpowers:subagent-driven-development` | ✗ (partial) | Reviewers yes, implementers no; see below |
| `superpowers:test-driven-development` | ◐ | Tasks 14–15 test-alongside; Task 13 implementation-first (§2) |
| `superpowers:requesting-code-review` | ✓ | Two reviews: Tasks 13–14, then the wiring, fix and docs |
| `superpowers:verification-before-completion` | ✓ | All four gates plus commitlint before each commit and at verify |
| `opsx:verify` | ✓ | `verify.md` |
| `superpowers:finishing-a-development-branch` | ✓ | PR via `gh pr create`, never merged locally |

### Deliberately Skipped Skills

- **What was skipped**: implementer subagents in `subagent-driven-development`. Tasks 13–16 were implemented by the controller, and only the reviews were dispatched.
- **Why this cycle**: plan.md predates PR 1. The brief listed eight interface deltas between the plan's snippets and the merged code: `daemonPaths` takes `build`, `ensurePrivateSocketDir`, client promotion, the `probeSocket` semantics, the `daemon status` log-only dirs, the close-without-`SHUTTING_DOWN` case, the `isJSONRPC*` names, and the factory's unused options. The controller had already read all of PR 1's `src/daemon/*` to absorb them. Re-encoding that context into four implementer briefs would have cost more than implementing the work, and the risk of a brief dropping a delta was the larger one. The handshake bypass (§2) shows what a review still catches.
- **How to prevent recurrence**: scope-judgment rule. When a plan predates the PR it builds on and the brief carries more than a handful of interface deltas, either reconcile `plan.md` against the merged code first (as `embedding-model-profiles` PR 4 did), so implementer briefs can cite it, or record inline implementation as a deliberate choice up front and double the review effort (one review per task, not per two). This cycle did the latter only halfway: it ran one review for Tasks 13–14 and one for the rest.

## 5. Surprises

- **The socket path does not depend on the cache directory.** Two sessions of one build with different `XDG_CACHE_HOME` share a daemon, whose state files live only in the spawner's cache dir. This is correct for the design (one daemon per build and user), but nobody had written it down. It is now in `shared-daemon.md`.
- **The daemon's RSS swings widely.** It was 884 MB right after serving three sessions' indexing and 374–390 MB a minute later. Reporting one RSS number for the daemon is misleading without saying when it was taken.
- **Shared is faster, not just smaller.** The design treated JSON vectors as a cost to watch. In practice a single model under less contention beat three in-process models on p95.
- **No library does this (research, 2026-10-15).** The owner asked mid-cycle whether a ready-made daemon library exists. Nx, Turborepo, Watchman and eslint_d all build it in-house. `core_d`, the closest library, uses a TCP port plus a token file. The in-house choice stands (`verify.md` S4).

## 6. Promote candidates → long-term learning

- [ ] 🔴 **For anything keyed by the installed build, walk the respawn path of a process started on the *previous* build.** The build can change under a running process (upgrade, `npm run build` behind a symlinked global install), and a "respawn from my own path" then starts a different build.
  → **Promote to** memory (feedback)
  > **Why**: `bf54098`. The design mitigated a rebuild for new sessions only. An old session's respawn started the new build on another key and stalled for 10 s, and the guide recommended the step that triggers it.
  > **How to apply**: when a process spawns or locates a sibling by its own executable path or version, add a manual check and a test where that file changes between startup and the spawn.

- [ ] 🟡 **When a lower layer gains per-connection setup, re-audit every path that can create a connection.** A helper that "reconnects for convenience" silently bypasses the setup.
  → **Promote to** memory (feedback)
  > **Why**: `request()` → `ensure()` was harmless until the facade added an `embed.initialize` handshake keyed on the connection epoch, and then it skipped the handshake (`7d3d07d`).
  > **How to apply**: when adding a handshake or auth step that runs per connection or session, grep for every call that can open one, and make exactly one function own connecting.
- [ ] 📌 **In a measurement driver, define "ready" by the state field the product reports, not by "no error".**
  → **Promote to** one-off (recorded here)
  > **Why**: `search_notes` degrades to lexical while indexing, so "no error" was true before any embedding ran, and the first numbers were meaningless.
  > **How to apply**: before timing a degradable tool, assert on its status field (`semantic_status.state === 'ready'`).
- [ ] 📌 **After `eslint --fix` or `prettier --write` on a file, re-read it before a scripted multi-line edit.**
  → **Promote to** memory (feedback)
  > **Why**: two scripted edits aborted on text the formatter had changed.
  > **How to apply**: any Python or sed edit anchored on multi-line text, in a file a formatter touched this session.
