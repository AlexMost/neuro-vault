# ADR-0004 — External processes via `execFile`, never a shell string

- **Status**: Accepted
- **Date**: 2026-06-08

## Context

The server shells out to the `obsidian` CLI for vault writes. Inputs to those invocations — note names, paths, property values — originate from an LLM caller and ultimately from user data. Building a command as an interpolated shell string (`exec(`obsidian create ${name}`)`) makes every such value a shell-injection surface: a backtick, `$(...)`, `;`, or quote in a note title becomes executable.

## Decision

All external process invocations use `child_process.execFile` with an **args array** — never `exec` with an interpolated string. `ObsidianCLIProvider` wraps every `execFile` call in `runCommand` (which also applies the timeout and routes failures through `mapExecError`). Arguments are passed as discrete array elements, so the OS executes the binary directly with no shell parsing the arguments.

## Consequences

- Note titles, paths, and property values containing shell metacharacters are passed verbatim to the binary, not interpreted — the injection surface is closed structurally, not by escaping.
- New external-command code follows the same shape; this is a hard convention in AGENTS.md, reviewable mechanically (grep for `exec(` / template strings in spawn calls).
- A small ergonomic cost: building an args array is more verbose than a single string, accepted.

## Alternatives considered

- **`exec` + manual escaping** — one missed escape is a vulnerability; rejected (escaping is the wrong default, allowlisting argument boundaries is right).
- **A shell wrapper for convenience** — reintroduces the parsing surface for no benefit.
