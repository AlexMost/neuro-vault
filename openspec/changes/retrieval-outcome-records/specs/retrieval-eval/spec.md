## MODIFIED Requirements

### Requirement: Standalone library execution
The runner MUST rank queries by importing the production ranking modules directly — no MCP client, no running server process. The fused pipeline SHALL invoke the production retrieval pipeline module that the `search_notes` tool invokes — the same leg wiring, existence-filter seam, rank fusion and effort-profile numbers — rather than re-assembling its legs, so that its ordering is the production fused ordering under the eval configuration by construction. The eval configuration SHALL read the effort-profile numbers from the module production reads them from rather than restating them.

#### Scenario: No server required
- **WHEN** the runner executes while no neuro-vault MCP server process exists
- **THEN** the run completes normally

#### Scenario: Fused ordering reuses production fusion
- **WHEN** the fused pipeline ranks a query
- **THEN** the final order is produced by the same retrieval pipeline function the `search_notes` tool calls

#### Scenario: A retuned effort profile reaches eval
- **WHEN** a deep-effort pool size changes in the effort-profile module
- **THEN** the next fused run uses the new value and records it in the report's `config`, with no edit under `eval/`
