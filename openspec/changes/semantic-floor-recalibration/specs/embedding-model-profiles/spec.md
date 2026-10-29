## MODIFIED Requirements

### Requirement: Similarity defaults belong to the profile

Every default similarity threshold the semantic tools apply SHALL come from the active profile: the `search_notes` effort defaults for `quick` and `deep`, its fallback retry threshold when the profile defines one, the deep block-evidence floor, the default `expansion_floor`, the `get_similar_notes` default threshold, and the `find_duplicates` default threshold. The fallback retry threshold SHALL be optional per profile, and a profile without one SHALL NOT retry. The block-evidence floor SHALL be a default of its own, independent of the `deep` effort default. Tool descriptions that state a default SHALL state the active profile's value, and SHALL NOT state a fallback retry for a profile that defines none. A caller-supplied threshold SHALL be applied as given, on whatever scale the active profile produces.

`harrier-270m` SHALL default to 0.45 at both `quick` and `deep`, SHALL define no fallback, and SHALL keep 0.13 as its block-evidence floor. `granite-97m` and `harrier-0.6b` SHALL keep their effort defaults and fallbacks, and each SHALL carry its `deep` default as its block-evidence floor.

#### Scenario: Two profiles apply their own defaults

- **WHEN** `search_notes` runs with no `threshold` at `effort: "deep"`, once under `harrier-270m` and once under `granite-97m`
- **THEN** each run filters the semantic leg at its own profile's deep default

#### Scenario: The description names the active defaults

- **WHEN** a client lists tools from a server started with `--model granite-97m`
- **THEN** the `search_notes` threshold description states `granite-97m`'s quick, deep and fallback values

#### Scenario: The description of a profile without a fallback states no retry

- **WHEN** a client lists tools from a server started with the default `harrier-270m` profile
- **THEN** the `search_notes` threshold description states its quick and deep values, says there is no retry, and names no fallback value

#### Scenario: The block-evidence floor does not follow the note floor

- **WHEN** a profile's `deep` default and its block-evidence floor differ
- **THEN** the deep block-evidence pass filters at the block-evidence floor, not at the `deep` default
