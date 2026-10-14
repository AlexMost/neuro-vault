## ADDED Requirements

### Requirement: The model flag selects one profile from a closed set

The command-line entry point SHALL accept `--model <key>` on the server
invocation and on the `index` subcommand, where `<key>` is one of the profile
keys of the embedding-model registry — `harrier-270m`, `granite-97m`,
`harrier-0.6b` — and SHALL default to `harrier-270m` when the flag is absent.
Any other value SHALL end startup with a non-zero exit before any vault is
opened or any model is loaded, with an error that lists the allowed keys.
`--help` SHALL list the allowed keys and the default. With semantics disabled
(`--no-semantic`), `--model` SHALL be accepted and have no effect.

#### Scenario: A valid key starts the server with that profile

- **WHEN** the server is started with `--vault <path> --model granite-97m`
- **THEN** it starts normally and every embedding it produces comes from
  `granite-97m`

#### Scenario: An unknown key is rejected before startup

- **WHEN** the server is started with `--vault <path> --model all-MiniLM-L6-v2`
- **THEN** the process exits non-zero, no vault is opened and no model is
  loaded, and the error lists the three allowed keys

#### Scenario: Help lists the choices

- **WHEN** the CLI is invoked with `--help`
- **THEN** the output documents `--model` with its allowed keys and its
  default
