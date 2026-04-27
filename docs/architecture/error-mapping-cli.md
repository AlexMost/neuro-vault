# Error Mapping (CLI)

How `ObsidianCLIProvider` translates `obsidian` CLI failures into structured `ToolHandlerError` codes that an MCP client (and the LLM behind it) can branch on.

## What it is

`src/modules/operations/obsidian-cli-provider.ts` wraps every `execFile` invocation in `runCommand`, which calls `mapExecError` on failure. `mapExecError` inspects the exception's `code`, `killed`, and `stderr` fields and returns a `ToolHandlerError` with one of the operations error codes.

## Why it exists

The Obsidian CLI does not return structured errors — it exits non-zero and prints human-readable text to stderr. To give the LLM something it can act on, we map specific stderr patterns to specific error codes.

## Mapping

| Signal                                                                                              | Error code               | Meaning                                                                       |
| --------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| spawn `ENOENT`                                                                                      | `CLI_NOT_FOUND`          | Binary not found at the configured path.                                      |
| `ETIMEDOUT` / `killed`                                                                              | `CLI_TIMEOUT`            | Process did not finish within `timeoutMs`.                                    |
| stderr matches `not running` or `URI handler`                                                       | `CLI_UNAVAILABLE`        | Binary exists but Obsidian is not running.                                    |
| `command === 'create'` and stderr matches `already exists`                                          | `NOTE_EXISTS`            | Hint to the LLM to ask the user before retrying with `overwrite: true`.       |
| `command === 'property:read'/'property:remove'` and stderr matches `property not found` / `not set` | `PROPERTY_NOT_FOUND`     | The named frontmatter property is not present on the note.                    |
| stderr matches `not found` (other commands)                                                         | `NOT_FOUND`              | The note does not exist.                                                      |
| Handler-side ISO date/datetime validation (before exec)                                             | `INVALID_ARGUMENT`       | `set_property` rejected a non-ISO `date`/`datetime` value up front.           |
| Handler-side type guard (before exec)                                                               | `UNSUPPORTED_VALUE_TYPE` | `set_property` got a value whose JS type cannot be mapped to a property type. |
| Anything else                                                                                       | `CLI_ERROR`              | Unknown failure; full `stderr` is in `details`.                               |

## Caveats

The pattern matching is fragile by design — it depends on stderr text from a tool we do not control. If a future Obsidian CLI version changes the wording, several mappings will silently degrade to `CLI_ERROR`. The mapping table in this file is the canonical place to update when that happens.

## Boundaries

- The provider does not log errors. It throws; the layer above (handlers, then the MCP wrapper) renders the error into a tool response.
- The provider never retries. The LLM decides what to do based on the error code.
