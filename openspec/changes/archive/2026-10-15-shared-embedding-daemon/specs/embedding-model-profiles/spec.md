## MODIFIED Requirements

### Requirement: One profile serves the whole process

A process SHALL select exactly one profile at startup and SHALL use it for every embedding it produces — query embeddings and indexing embeddings, for every vault it serves. The model weights for that profile MAY be held by the shared daemon on the process's behalf rather than in the process itself; either way the process embeds with that one profile only. The corpus identity the process writes to and validates manifests against SHALL be derived from that profile, so a vault's corpus can only be served by a process running the profile that built it, whether the model is local or shared.

#### Scenario: Two vaults share the selected profile

- **WHEN** a server started with `--model granite-97m` serves two vaults
- **THEN** both vaults are indexed and queried with `granite-97m`, and only one model is loaded — in the daemon by default, or in the process with `--no-shared`

#### Scenario: The corpus identity follows the profile

- **WHEN** a process running `granite-97m` writes a corpus manifest
- **THEN** the manifest names `granite-97m`, its repository id and revision, and 384 dimensions

#### Scenario: The identity does not depend on where the model lives

- **WHEN** one process embeds `granite-97m` through the daemon and another with `--no-shared`
- **THEN** both write the same corpus identity
