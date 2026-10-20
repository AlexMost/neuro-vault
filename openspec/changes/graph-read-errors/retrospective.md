# Retrospective: graph-read-errors

## 0. Evidence

- One PR, `Closes #212`. The tests went from 2841 to 2867.
- Whole-branch review: 0 Critical, 1 Important (fixed), 3 Minor (1 fixed, 2 kept, see
  verify.md §4).
- The work was prepared on a branch stacked on #211 (graph-in-daemon PR 2) while #211 awaited
  merge. It was rebased onto `main` before the PR.

## 1. Wins

- A decorator over `IGraphReader` kept the change at one expression per consumer. The lib
  functions that take a reader did not change.
- The mutation check (disabling the mapping) proved each new consumer test fails without the
  fix.

## 2. Misses

- The design assumed a resource read surfaces a `ToolHandlerError` the way a tool call does.
  It does not: resources have no tool envelope, and the SDK keeps only the message. The
  resource test called the handler directly, so it could not see this. The reviewer caught it.

## 3. Plan deviations

- Added a test that `get_similar_notes` with the query note missing on disk is still
  `NOT_FOUND`. The plan assumed such a test already existed; none did.
- The spec and docs for the resource were narrowed after review (verify.md §4).

## 4. Skill / workflow compliance

The brainstorming skill was invoked. The brief from the starting session settled every
question, so there was no question round, and the choices it did not cover are marked as this
session's calls in brainstorm.md (Q3, Q4). writing-plans produced plan.md, which ran natively
with one fresh reviewer at the end.

### Deliberately Skipped Skills

- subagent-driven-development: the tasks were small and shared one interface, so the plan
  chose native execution.

## 5. Surprises

- The MCP SDK maps any error thrown by a resource handler to JSON-RPC `InternalError`
  (-32603) unless `error.code` is a safe integer. A string `code` is therefore dropped.

## 6. Promote candidates → long-term learning

- Before specifying an error shape for an MCP resource, check how the SDK serializes a
  resource handler's throw. Tool and resource errors travel differently.
