# tool-response-envelope Specification

## Purpose
TBD - created by archiving change compact-tool-response-contract. Update Purpose after archive.
## Requirements
### Requirement: Success text is the minified equivalent of the structured payload

Every successful tool result SHALL serialize its payload into `content[0].text` with `JSON.stringify(value)` (no pretty-print indentation). When the payload is a plain object, the result SHALL also carry the same object in `structuredContent`, and the text SHALL be exactly `JSON.stringify(structuredContent)` — a functionally equivalent single serialization, per the MCP specification's backwards-compatibility recommendation.

#### Scenario: object payload is emitted minified in both channels

- **WHEN** a tool handler resolves with a plain object payload
- **THEN** `content[0].text` equals `JSON.stringify(structuredContent)` and contains no indentation whitespace

#### Scenario: non-object payload gets text only

- **WHEN** a tool handler resolves with a value that is not a plain object (e.g., an array)
- **THEN** `content[0].text` is the minified JSON of that value and `structuredContent` is absent

#### Scenario: void payload keeps the ok sentinel

- **WHEN** a tool handler resolves with `undefined`
- **THEN** `content[0].text` is `ok` and `structuredContent` is absent

### Requirement: Error text carries the error code and details

A tool result for a `ToolHandlerError` SHALL set `content[0].text` to `` `${code}: ${message}` ``, and when the error has `details`, SHALL append a second line `` `details: ${JSON.stringify(details)}` ``. The structured error payload `{ code, message, details }` in `structuredContent` SHALL remain unchanged, and `isError` SHALL remain `true`.

#### Scenario: handler error without details

- **WHEN** a tool handler throws `ToolHandlerError('VAULT_NOT_FOUND', 'vault "x" is not registered')` with no details
- **THEN** `content[0].text` is `VAULT_NOT_FOUND: vault "x" is not registered` with no details line

#### Scenario: handler error with details

- **WHEN** a tool handler throws a `ToolHandlerError` carrying `details`
- **THEN** `content[0].text` starts with `` `${code}: ${message}` `` and its second line is `details: ` followed by the minified JSON of `details`

#### Scenario: structured error channel is unchanged

- **WHEN** any `ToolHandlerError` is converted to a tool result
- **THEN** `structuredContent` equals `{ code, message, details }` and `isError` is `true`

### Requirement: Unknown errors keep message-only text

An error that is not a `ToolHandlerError` SHALL produce `content[0].text` containing only its message (or `Unknown tool error` when no message exists), with no code prefix, and `structuredContent` of `{ message }` with `isError: true`.

#### Scenario: plain Error thrown by a handler

- **WHEN** a tool handler throws `new Error('disk read failed')`
- **THEN** `content[0].text` is `disk read failed` and `structuredContent` is `{ message: 'disk read failed' }`

### Requirement: A resource read error carries the error code and details
A resource read whose handler throws a `ToolHandlerError` SHALL fail with JSON-RPC error code `-32603`, the `ToolHandlerError`'s message as the error message, and `data: { code, details }`, where `details` is present only when the error has details. The error's cause SHALL NOT appear in the response. An error that is not a `ToolHandlerError` SHALL be rethrown unchanged, so the SDK answers it as before: a plain `Error` reaches the client with code `-32603`, its message, and no `data`.

#### Scenario: handler error with details

- **WHEN** a resource handler throws `ToolHandlerError('DEPENDENCY_ERROR', 'Graph read failed', { details: { vault: 'work', operation: 'vault://overview' } })`
- **THEN** the read fails with JSON-RPC error code `-32603`, JSON-RPC error message `Graph read failed`, and `data` equal to `{ code: 'DEPENDENCY_ERROR', details: { vault: 'work', operation: 'vault://overview' } }`

#### Scenario: handler error without details

- **WHEN** a resource handler throws a `ToolHandlerError` with no details
- **THEN** the JSON-RPC error's `data` is `{ code }` with no `details` key

#### Scenario: the cause stays off the wire

- **WHEN** a resource handler throws a `ToolHandlerError` whose cause has the message `daemon did not answer in time`
- **THEN** that message appears nowhere in the JSON-RPC error

#### Scenario: plain Error thrown by a resource handler

- **WHEN** a resource handler throws `new Error('disk read failed')`
- **THEN** the read fails with JSON-RPC error code `-32603`, JSON-RPC error message `disk read failed`, and no `data`

