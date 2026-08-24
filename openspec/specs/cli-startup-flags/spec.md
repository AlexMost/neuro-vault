# cli-startup-flags Specification

## Purpose
TBD - created by archiving change cli-version-flag. Update Purpose after archive.
## Requirements
### Requirement: The CLI reports its own version

The command-line entry point SHALL accept `--version` and write the version
declared in the package manifest to stdout, as a bare version string with no
program name, prefix, or surrounding text.

Version reporting is the first question in a bug report and the only way to tell
whether an `npx` cache is stale, so it MUST be answerable from the binary alone.

#### Scenario: --version prints the manifest version

- **WHEN** the CLI is invoked with `--version`
- **THEN** stdout receives exactly the version string from the package manifest
  followed by a newline (for example `15.4.0`), and nothing else

#### Scenario: --version needs no vault

- **WHEN** the CLI is invoked with `--version` and no `--vault` argument
- **THEN** the process exits with code 0 and no error is written to stderr

#### Scenario: The reported version matches the MCP server identity

- **WHEN** the version reported by `--version` is compared with the `version`
  field the server advertises in its MCP identity
- **THEN** the two strings are equal, because both read one shared source

---

### Requirement: A flag the parser has already satisfied ends startup cleanly

Startup SHALL terminate with exit code 0, without running vault validation and
without connecting the stdio transport, whenever the argument parser has itself
fulfilled the invocation — printing help or a version rather than producing a
runnable configuration.

The parser is configured not to exit the process on its own, because argument
parsing is a library concern and MUST NOT kill its caller. The entry point is
therefore responsible for acting on the parser's signal; "the CLI ended without
producing a configuration" MUST be an explicit, representable outcome rather
than an unhandled path that falls through into configuration validation.

#### Scenario: --help exits cleanly

- **WHEN** the CLI is invoked with `--help` and no `--vault` argument
- **THEN** the help text is written and the process exits with code 0, with no
  `--vault is required` message on stderr

#### Scenario: An informational flag never opens the transport

- **WHEN** the CLI is invoked with `--version` or `--help`
- **THEN** no MCP server is constructed and no stdio transport is connected, so
  the JSON-RPC channel on stdout carries only the requested output

#### Scenario: A real invocation is unaffected

- **WHEN** the CLI is invoked with a valid `--vault <absolute path>` and no
  informational flag
- **THEN** parsing yields a runnable configuration and the server starts as
  before

#### Scenario: A missing vault is still an error

- **WHEN** the CLI is invoked with neither `--vault` nor any informational flag
- **THEN** startup fails with the `--vault is required` message and a non-zero
  exit code

---

### Requirement: One module owns the package version

The package name and version SHALL be read from the package manifest in exactly
one module, which every consumer imports; no consumer may read the manifest
independently.

That module MUST resolve the manifest by a path that is correct both when
running from source and when running from the bundled build output. The bundler
flattens the build into a single file and does not rewrite the literal path
string handed to the module-resolution helper, so the module's location within
the source tree is load-bearing and MUST be verified against the build output,
not only against source-level tests.

#### Scenario: Source and bundle agree

- **WHEN** `--version` is run against the source entry point and against the
  bundled build output
- **THEN** both print the same version string and exit 0

#### Scenario: No second manifest read

- **WHEN** the source tree is searched for reads of the package manifest
- **THEN** exactly one module performs the read

