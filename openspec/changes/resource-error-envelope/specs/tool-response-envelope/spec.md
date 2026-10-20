## ADDED Requirements

### Requirement: A resource read error carries the error code and details
A resource read whose handler throws a `ToolHandlerError` SHALL fail with JSON-RPC error code `-32603`, the `ToolHandlerError`'s message as the error message, and `data: { code, details }`, where `details` is present only when the error has details. The error's cause SHALL NOT appear in the response. An error that is not a `ToolHandlerError` SHALL reach the client as the SDK answers it, with its message and no `data`.

#### Scenario: handler error with details

- **WHEN** a resource handler throws `ToolHandlerError('DEPENDENCY_ERROR', 'Graph read failed', { details: { vault: 'work', operation: 'vault://overview' } })`
- **THEN** the client's read fails with code `-32603`, message `Graph read failed`, and `data` equal to `{ code: 'DEPENDENCY_ERROR', details: { vault: 'work', operation: 'vault://overview' } }`

#### Scenario: handler error without details

- **WHEN** a resource handler throws a `ToolHandlerError` with no details
- **THEN** the client's `data` is `{ code }` with no `details` key

#### Scenario: the cause stays off the wire

- **WHEN** a resource handler throws a `ToolHandlerError` whose cause has the message `daemon did not answer in time`
- **THEN** that message appears nowhere in the client's error

#### Scenario: plain Error thrown by a resource handler

- **WHEN** a resource handler throws `new Error('disk read failed')`
- **THEN** the client's read fails with code `-32603`, message `disk read failed`, and no `data`
