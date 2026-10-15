# Verification Report

**Change**: `shared-embedding-daemon`
**Verified at**: `2026-10-15 21:05`
**Verifier**: Claude Opus 5.5 (`/opsx:apply` PR 2 session). The requirement→scenario mapping in §4 was done by a Sonnet subagent and checked by the controller.

Scope: the whole change. PR 1 is merged (#147, `7d96dbf`). PR 2 is this branch, `claude/shared-daemon-pr2-6aff26`, `7d96dbf..HEAD`.

---

## 0. Gates

| gate | result |
| --- | --- |
| `npm test` | ✅ 136 files passed, 1 skipped; **1804 passed / 4 skipped**. That is +61 over PR 1 on `main` (`7d96dbf`), which had 1743 passed / 4 skipped. |
| `npm run lint` | ✅ clean (`eslint .`) |
| `npm run typecheck` | ✅ clean (`tsc --noEmit`) |
| `npm run build` | ✅ |
| `npx commitlint --from origin/main --to HEAD` | ✅ |

---

## 1. Structural Validation (`openspec validate --all`)

- [x] Every item is `"valid": true`

**Result**:

```text
✓ change/shared-embedding-daemon
… (20 items total)
Totals: 20 passed, 0 failed (20 items)
```

| Item | Type | Issues |
|---|---|---|
| — | — | — |

---

## 2. Task Completion (`tasks.md`)

- [ ] Every `- [ ]` is now `- [x]`. 22 of 23 are checked. The open one is 2.10 (verify → retrospective → archive → PR), and this report is its first step.

| Task | Why it is open | Blocks archive? |
|---|---|---|
| 2.10 verify, retrospective, archive, PR | In progress: this report, then the retrospective, then `openspec archive`, then the PR | No |

Task 2.7 is checked with a note. Its steps ran against real `node dist/cli.js` stdio servers driven over MCP (§8), not inside the owner's Claude Code sessions. Those are listed in §8 as an owner check, not a gap.

---

## 3. Delta Spec Sync State

| Capability | Sync state | Notes |
|---|---|---|
| `shared-services-daemon` | ✗ needs sync (new capability) | `openspec/specs/shared-services-daemon/` does not exist yet; archive creates it (7 requirements) |
| `daemon-embedding-provider` | ✗ needs sync (new capability) | archive creates it (4 requirements) |
| `cli-startup-flags` | ✗ needs sync | 2 ADDED requirements, names absent from the main spec |
| `semantic-backend-lifecycle` | ✗ needs sync | 1 MODIFIED requirement; the name matches the main spec exactly |
| `embedding-model-profiles` | ✗ needs sync | 1 MODIFIED requirement; the name matches the main spec exactly |

---

## 4. Requirements → implementation, scenarios → evidence

**Requirements: 15 / 15 implemented, all matching their intent. Scenarios: 54.** 45 are covered by tests or tests plus a manual run, and 9 are partial. The 54th, "Upgraded under an open session", was added to the delta spec at verify together with its fix (`bf54098`, W1). None is uncovered. The full per-scenario table, with `file:line` and exact test names, was produced by the mapping agent; the summary is below.

| Capability | Requirements | Scenarios | Partial |
|---|---|---|---|
| `shared-services-daemon` | 7/7: one process per build; stale state under lock; JSON-RPC over stdio framing; idle exit after the last client; orderly bounded stop; info file and log; `status`/`stop` | 19 | 4 (P1–P4) |
| `daemon-embedding-provider` | 4/4: embed service per profile with a cross-client queue; the facade keeps the provider contract; the facade finds/starts the daemon and bounds every wait; one fallback | 19 | 1 (P5) |
| `cli-startup-flags` | 2/2: the `daemon` outcome; one `--shared` flag | 8 | 2 (P6, P7) |
| `semantic-backend-lifecycle` | 1/1 (modified) | 5 | 1 (P8) |
| `embedding-model-profiles` | 1/1 (modified) | 3 | 1 (P8, same gap) |

Selected evidence for PR 2's own requirements:

| Scenario | Evidence |
|---|---|
| Daemon already running | `daemon-connection.test.ts` "connects without spawning when the daemon listens"; `daemon-facade-integration.test.ts`; manual 2.7 #1b |
| Daemon started on demand | `daemon-connection.test.ts` "creates the state dir, spawns detached with the log fd, and polls until the socket answers"; manual 2.7 #1 |
| Two sessions start at once | Manual, added at verify (P5 below): three sessions opened in parallel on a fresh key spawned three daemons. Two exited into `daemon.log` with `daemon is already running (pid 29609)`, and one served `clients 3  loaded [harrier-270m]` |
| Daemon idled out mid-session | `daemon-connection.test.ts` "rejects pending requests when the socket closes and reconnects on the next call"; `daemon-facade-integration.test.ts` "a daemon that stops answers the in-flight request and the next call reconnects"; manual 2.7 #7 |
| A hung daemon cannot hang the session | `daemon-connection.test.ts` "times out a request that is never answered, naming the method" |
| Same identity either way | `cli-index.test.ts` "writes the same corpus identity whether the model is shared or in-process"; `provider-factory.test.ts` "returns the daemon facade when shared, with the in-process identity, touching nothing yet" |
| Warmup loads the model in the daemon once | `server-modules.test.ts` "warms up through the injected embedding provider, behind the per-process queue"; `embed-service.test.ts` "builds one provider per profile, however many clients initialize it"; manual 2.7 #2 |
| Batch size follows the daemon | `daemon-embedding-provider.test.ts` "feeds the per-process queue the daemon batch size", "chunks a document batch larger than the daemon reports" |
| Spawn fails / development run / opting out | `daemon-connection.test.ts` "wraps a spawn throw and still closes the log fd", "refuses to spawn from a TypeScript entry point (%s)"; `provider-factory.test.ts` "falls back, never throwing the log error, when daemon.log cannot be opened"; `config.test.ts` "--no-shared selects the in-process provider on both commands"; manual 2.7 #5, #6 |
| Upgraded under an open session | `daemon-connection.test.ts` "refuses to spawn a daemon for a CLI script rebuilt since this session started", "refuses to spawn when the CLI script is gone"; `provider-factory.test.ts` "falls back at once after an upgrade replaced the CLI script, instead of spawning the new build"; manual 2.7 #8 |
| Model load failure is not a fallback | `daemon-embedding-provider.test.ts` "does not fall back on EMBED_FAILED and retries through the daemon next time" |
| `index` shares a running server's model | `cli-index.test.ts` (wiring, identity); manual 2.7 #3 (121 MB peak, no model loaded) |

**Partial scenarios:**

- **P1 — "A live daemon wins the race."** Lock-race unit tests (`lock.test.ts` I1 and its mirror) plus a sequential second daemon (manual 1.11). The facade-side race was run at verify: see the "Two sessions start at once" row.
- **P2 — "Unknown method."** The registry's answer is tested (`protocol.test.ts`). That the connection stays open afterwards is not asserted over a real socket.
- **P3 — "Diagnostics stay off stdout."** The start line is asserted (`cli-daemon.test.ts`, `h.out` empty). The daemon logs no model-load or client-error lines at all, so the spec's conditional holds vacuously. Checked at verify: a foreground `daemon` that loaded `granite-97m` and served `embed.query` and an `UNKNOWN_PROFILE` wrote **0 bytes** to stdout and exited 0 on `SIGTERM`. See S5.
- **P4 — "Stop ends every daemon."** Tested with one live daemon plus one starting entry, not with two live daemons of different builds.
- **P5 — "Two sessions start at once."** Closed by the manual run above; there is no automated equivalent.
- **P6 — "Run outcome."** `--idle-timeout 5` itself is not parsed in a test (30 and 0 are; same function).
- **P7 — "Help lists the command."** The test asserts the daemon description, not that `$0` and `index` are still listed.
- **P8 — "Two vaults share the model / the selected profile."** No server-level test runs two vaults through one queue. This is pre-existing: `embedding-model-profiles` verify W2 named the same gap. It is unchanged here, and the facade wiring sits on the same line (`server.ts`).

The mapping also noted that `daemon.json` carries `cli_size` and `cli_mtime_ms` beyond the four fields the spec names. They are harmless and documented in `shared-daemon.md`; see S2.

---

## 5. Design / Specs Coherence Spot Check

| Sample | design | specs | Gap |
|---|---|---|---|
| D2 error codes | `UNKNOWN_METHOD`, `INVALID_PARAMS`, `UNKNOWN_PROFILE`, `EMBED_FAILED`, `SHUTTING_DOWN` | shared-services-daemon protocol requirement | The code adds `INTERNAL` for a handler that throws a non-`DaemonRpcError`. It is documented in `shared-daemon.md`; not in the spec list (S1) |
| D3 key | version + CLI size + mtime | spec: "version-keyed socket" | The spec says *version*; the design and code key by *build*. Its wording is a superset that names only part of the key (S2) |
| D5 idle from last client | a connection becomes a client with its first non-`daemon.*` request | spec idle scenarios | none |
| D6 timeouts / fallback | 15 min / 60 s / 5 min; fallback once only on locate/start failure | daemon-embedding-provider req. 3–4 | The spec names 60 s and 5 min only; 15 min initialize is design-only. No gap |
| D6 handshake | (added in PR 2) `embed.initialize` first on every connection | provider contract: "maxBatchSize is the daemon's once known" | design.md updated in this PR to say so |
| D7 one factory | server, `index`, daemon all through `createEmbeddingProvider` | "The session SHALL obtain its embedding provider from one factory" | none; the daemon side is pinned by `daemonProviderFor` |

**Drift warnings** (non-blocking): S1 and S2 below.

---

## 6. Implementation Signal

- [x] Worktree has no unstaged or untracked files (`git status --short` empty)
- [ ] Every relevant commit is pushed. Not yet: the push happens with the PR (2.10)

**Commit range**: `7d96dbf..HEAD`

```text
827b803 feat(semantic): daemon connection — locate, spawn, poll, request
4239310 feat(semantic): daemon-backed embedding provider with one-way fallback
0db3f1c feat(semantic): embed through the shared daemon by default; --no-shared opts out
7d3d07d fix(semantic): never reconnect inside a daemon request
e573827 docs: shared embedding daemon — guide, architecture, facade
bf54098 fix(semantic): never respawn a daemon from a CLI script rebuilt under the session
```

---

## 7. Front-Door Routing Leak Detector (warning, non-blocking)

- [x] `docs/superpowers/specs/*.md`: no files

---

## 8. Manual checks and measurements (tasks 1.11, 2.7, 2.8) and deferred-dogfood equivalence

`plan.md` has no `[~]` rows, so nothing was deferred silently. The manual checks were run as follows.

### 1.11: the daemon alone (PR 1, 2026-10-14, macOS, worktree build)

Recorded in #147's body and repeated here:

- **Start.** `node dist/cli.js daemon --idle-timeout 1` prints one stderr line, nothing on stdout. The directory is `drwx------`, the socket `srw-------`, and `daemon.json` holds the six fields.
- **Raw `nc -U` session.**
  - `daemon.info` shows `loaded: []`.
  - `embed.initialize granite-97m` answers with the identity and `max_batch_size: 8`.
  - `embed.query` with `"` and `\n` in the text returns 384 finite floats.
  - `embed.documents` with 8 texts returns 8×384; with 9 it is `INVALID_PARAMS`.
  - An unknown profile gets `UNKNOWN_PROFILE`, and `lexical.search` gets `UNKNOWN_METHOD`.
- **Second instance.** A second `daemon` exits 1 with "already running".
- **`status`.** Shows the daemon `alive`.
- **Idle exit.** About 1 min after the last client leaves, it exits 0 and removes its files.
- **`kill -9`.** The leftovers are swept by `status`, or cleaned by the next start.
- **`stop`.** Exits 0.
- **`SIGTERM`.** Exits 0 in 31 ms.
- **Rebuild.** Gives a new key.
- **`--idle-timeout 35792`.** Rejected.
- **Socket directory.** A symlinked one is refused.

### 2.7: sessions through the facade (PR 2, 2026-10-15, macOS, Node 24.13, worktree build)

**Setup.** A throwaway 40-note vault and a scratch `XDG_CACHE_HOME`, whose `models` is a symlink to the real model cache. The driver (session scratchpad, not committed) spawns `node dist/cli.js --vault <v>` stdio servers through the MCP SDK's `StdioClientTransport` and calls `search_notes` until `semantic_status.state` is `ready`. The owner's live install and `~/.cache/neuro-vault/daemons` were not touched.

| # | Check | Result |
|---|---|---|
| 1 | One session, no daemon running | The daemon is spawned on demand. `daemon.log` holds its start line; `search_notes` works |
| 1b | A second session run | It connects to the running daemon without spawning; `status`: `clients 1  loaded [harrier-270m]` |
| 2 | Two sessions | `daemon status`: one daemon, `clients 2  loaded [harrier-270m]`; `search_notes` works in both |
| 3 | `index --vault <fresh copy>` while a session is open | 40/40 notes embedded through the daemon. The `index` process peaked at **121 MB RSS** with 0.33 s user CPU: no model of its own. `status` still showed one loaded profile. The same run with `--no-shared` peaked at **974 MB** with 48.7 s user CPU |
| 4 | Rebuild mid-session (`touch dist/cli.js`: same version, new mtime, new key) | A new session got a second daemon (`246c764b06f3` beside `0b891538061a`). The old session's next `search_notes` still answered through the old daemon. After both closed, both showed `clients 0` (idle timers armed). The idle exit after the default 30 min: see the note below this table |
| 5 | `--no-shared` | No daemon spawned and no new state directory; `search_notes` works |
| 6 | `npm run dev` equivalent (`tsx src/cli.ts`) | Exactly one stderr line: `neuro-vault-mcp: shared embedding daemon unavailable (the daemon cannot be started from a TypeScript entry point (development run)); embedding in-process for this session — see …/daemon.log`. Tools work; `status`: `no daemon known` |
| 8 | Upgrade under an open session (added at verify, after `bf54098`): `touch dist/cli.js`, then `daemon stop` | `stopped 17.0.0 (pid 30725)`. The session's next `search_notes` fell back at once and succeeded in 1014 ms, the in-process model load included; the call after that took 47 ms. One stderr line: `… unavailable (the CLI script at …/dist/cli.js changed since this session started (upgraded or rebuilt); restart the session to use the new version); embedding in-process for this session — see …/daemon.log`. Before the fix, the session would have polled the old socket for 10 s first |
| 7 | `daemon stop` with a session open | `stopped 17.0.0 (pid 20422)`. The session's next `search_notes` respawned the daemon (new pid 21200) and succeeded in 1.9 s, model load included. The call after that took 53 ms |

**Idle exit with the default timeout (check 4, observed).** Both daemons of the rebuild check had `clients 0` after their sessions closed: the old build's `0b891538061a` (pid 24269), and the new build's `246c764b06f3` (pid 24276), which a later measurement run briefly reconnected to. Neither was given `--idle-timeout`, so they ran on the facade's default 30 minutes. A background check 31.7 minutes after that rebuild run found both pids gone and `daemon status` reporting `no daemon known`. The measurement daemon `9a8688db887d` had also exited. Every `daemon.log` holds only its start line, so each exit was the idle path, not a crash or a stop.

**Owner check (not run here).** Repeat 2, 3 and 7 with two real Claude Code sessions on a build of this branch, then watch `neuro-vault-mcp daemon status`. This session did not touch the owner's global install. The global binary is a symlink into the main checkout, and a build there would change the code behind the owner's live sessions.

### 2.8: measurements (same setup; 3 sessions concurrently)

| | `--shared` (default) | `--no-shared` |
|---|---|---|
| RSS after 5 `search_notes` each | sessions 129 / 129 / 130 MB, plus daemon **884 MB** = **≈ 1.27 GB** | 675 / 839 / 885 MB = **≈ 2.40 GB**; a second run gave 795 / 874 / 880 = 2.55 GB |
| `search_notes` latency, 3 sessions × 30 concurrent (90 calls) | p50 **136 ms**, p95 **159 ms**, max 209 ms | p50 178 ms, p95 220 ms, max 276 ms |

The daemon's RSS falls back to 374–390 MB idle once inference stops. The 884 MB is its high-water mark after serving three sessions' indexing and queries. JSON vectors cost nothing visible: shared p95 is lower than in-process, because one model instance means less CPU contention than three. Base64 float32 (design D2) is not needed.

### Deferred dogfood vs automated equivalence

| Manual check | Equivalent automated test | Assessment |
|---|---|---|
| 2.7 #1/#7 spawn, respawn after stop | `daemon-connection.test.ts` "creates the state dir, spawns detached with the log fd, and polls until the socket answers", "rejects pending requests when the socket closes and reconnects on the next call"; `daemon-facade-integration.test.ts` "a daemon that stops answers the in-flight request and the next call reconnects" | Covered except the real `spawn` of a real `cli.js` (manual only) |
| 2.7 #2 one model across sessions | `embed-service.test.ts` "builds one provider per profile, however many clients initialize it"; `socket-server.test.ts` "answers requests from two clients and counts them once they send a request" | Covered at the service level |
| 2.7 #3 `index` shares the model | `cli-index.test.ts` "writes the same corpus identity whether the model is shared or in-process" | Partial: the wiring and identity are covered; "loads no model" is manual only |
| 2.7 #4 rebuild → new daemon | `paths.test.ts` "differs for the same version when the build differs" | Covered at the key level; the two-daemon coexistence is manual only |
| 2.7 #5 `--no-shared` | `config.test.ts` `--shared` block; `provider-factory.test.ts` "returns the in-process provider when not shared" | Covered |
| 2.7 #6 `.ts` fallback | `daemon-connection.test.ts` "refuses to spawn from a TypeScript entry point (%s)"; `daemon-embedding-provider.test.ts` "falls back once when the daemon is unavailable, with one stderr line naming the log" | Covered |
| 2.8 RSS and p95 | — | Measurement only, by nature; no gap |

---

## Warnings

- **W1: fixed during verify.** An upgrade under an open session broke the facade's restart. The second review found it in `0db3f1c`'s wiring, and the docs then recommended the step that triggers it: after an upgrade or rebuild, a session whose daemon went away (`daemon stop`, a crash) spawned the *new* `cli.js`, which keyed itself on another socket. The session then polled its old socket for 10 s before falling back. Fixed in `bf54098`:
  - the connection re-stats the script before every spawn and is unavailable at once if it changed;
  - the spawned daemon's cwd is the home directory;
  - the guide and design now say to restart old sessions after an upgrade;
  - the delta spec gained the "Upgraded under an open session" scenario;
  - manual 2.7 #8 confirms it.
- **W2: the server-level two-vaults-one-model test is still missing** (P8). This is the same gap `embedding-model-profiles` verify W2 recorded, and it is still open. It is carried into a follow-up, together with the minor test pins P2, P4, P6 and P7.
- **W3: owner check.** Repeat 2.7 #2, #3 and #7 in two real Claude Code sessions on a build of this branch. This session left the owner's live install alone (§8).

## Suggestions

- **S1:** `INTERNAL` is a sixth `data.code` that the shared-services-daemon spec does not list. Add it to the spec's error list at the next change touching the protocol.
- **S2:** the spec says "version-keyed socket" while the key is per *build* (D3). Reword to "build-keyed" in a later spec edit.
- **S3 (from the PR 2 code review, deferred):**
  - The spawned daemon inherits the session's cwd. Consider `cwd: os.homedir()`.
  - A Windows pipe whose instances are all busy can exceed the 2 s connect timeout and make that session fall back. Both are untested on Windows.
  - Retrying once on `SHUTTING_DOWN` (embed requests are idempotent) would hide a `daemon stop` from the one search in flight. The spec allows surfacing it, as now.
- **S5:** the daemon writes nothing to `daemon.log` after its start line. It logs no profile load (with its time) and no load failure, and both go only to the requesting client as a result or `EMBED_FAILED`. The fallback line and the guide both point users at `daemon.log`, so one stderr line per load and per load failure would make that log worth opening. Small; a follow-up.
- **S4 (research, 2026-10-15):** no maintained npm library covers spawn-on-demand + private unix socket + lock + idle exit.
  - `core_d` uses a TCP port plus a token file and is CommonJS.
  - `pm2` is AGPL-3.0 and heavy.
  - `forever`, `daemon` and `daemonize2` are abandoned.
  - `node-ipc` had the CVE-2022-23812 protestware incident.
  - Nx, Turborepo, Watchman and eslint_d all build this in-house from the same parts.
  - Recommendation: keep the in-house lifecycle. `json-rpc-2.0` could replace only the client's id/timeout bookkeeping, at the cost of a second JSON-RPC idiom.

---

## Overall Decision

- [ ] ✅ PASS — ready for finishing-a-development-branch and archive
- [x] ⚠️ PASS WITH WARNINGS — ready for the next steps, with these noted. W1 was found and fixed during verify. W2 is a pre-existing coverage gap, filed as a follow-up together with the minor partials. W3 is the owner's check in real Claude Code sessions before merge.
- [ ] ❌ FAIL — return to the failing artifact, fix it, and re-run verify

**Next step**: `retrospective.md` → `npx openspec archive shared-embedding-daemon -y` → push, then open the PR with `Closes #145` and the release notes. Stop there for review.
