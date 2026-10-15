## ADDED Requirements

### Requirement: The daemon command is parsed into its own outcome

The argument parser SHALL recognise a `daemon [action]` command, where `action` is absent (run the daemon) or one of `status`, `stop`, and SHALL represent it as a distinct parse outcome so the entry point branches on the outcome kind and never starts the stdio transport or runs vault validation for it. `daemon` SHALL accept `--idle-timeout <minutes>` — an integer of at least 0, default 30, declared once — and SHALL reject `--vault` and `--model`. An unknown action SHALL fail with the allowed list. `$0`, `index`, `--help` and `--version` SHALL behave exactly as before.

#### Scenario: Run outcome

- **WHEN** the CLI is invoked with `daemon --idle-timeout 5`
- **THEN** parsing yields the daemon outcome with no action and an idle timeout of 5, and no vault is validated

#### Scenario: Status needs nothing else

- **WHEN** the CLI is invoked with `daemon status`
- **THEN** parsing yields the daemon outcome with action `status` and no `--vault is required` error

#### Scenario: Unknown action

- **WHEN** the CLI is invoked with `daemon restart`
- **THEN** the process exits non-zero and the error lists `status` and `stop`

#### Scenario: Invalid idle timeout

- **WHEN** the CLI is invoked with `daemon --idle-timeout -1` or `daemon --idle-timeout soon`
- **THEN** the process exits non-zero and the error names a non-negative integer

#### Scenario: Help lists the command

- **WHEN** the CLI is invoked with `--help`
- **THEN** the output lists `daemon` with its description and still lists the default command and `index`

---

### Requirement: One shared flag selects the daemon-backed or in-process provider

`--shared` SHALL be a boolean option declared once and attached to the server invocation and to `index`, default `true`; `--no-shared` SHALL select the in-process embedding provider. The parsed configuration of both invocations SHALL carry the value so the two are copyable between each other unchanged. With `--no-semantic`, `--shared` SHALL be accepted and have no effect.

#### Scenario: Default is shared

- **WHEN** the server is started with `--vault <path>` and no `--shared` flag
- **THEN** the configuration marks the embedding provider as shared

#### Scenario: Opting out on both commands

- **WHEN** `--vault <path> --no-shared` and `index --vault <path> --no-shared` are parsed
- **THEN** both configurations mark the provider as not shared

#### Scenario: Help documents the flag

- **WHEN** the CLI is invoked with `--help`
- **THEN** the output documents `--shared` with its default on both commands
