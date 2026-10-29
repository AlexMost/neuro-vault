## MODIFIED Requirements

### Requirement: Calibration statistics

With `--stats`, the runner SHALL add to its report the similarity distributions a threshold calibration needs, each summarised as quantiles. Three of them are ranked: the query↔note similarities of the golden queries' ranked candidates, the seed↔neighbour similarities the expansion leg sees, and every in-scope note's top-10 neighbour similarities. Three are unranked: each golden query's similarity to every note, each seed's similarity to every note that is not one of its query's seeds, and every note's similarity to every other note. A seventh holds each note's maximum similarity to any other note. Each similarity default's pass rate SHALL be measured on an unranked population, or for `duplicates` on the per-note maximum: `quick`, `deep` and `fallback` on query↔every note, `expansionFloor` on seed↔every note, `similarNotes` on note↔every note, and `duplicates` on each note's maximum similarity to any other. For each of these defaults that the selected profile defines, the report SHALL record that population and the share of it that the default lets through; a default the profile does not define SHALL have no pass rate. The block-evidence floor SHALL NOT be measured, because no query↔block population is collected. It SHALL also record two golden-set guards: how many first-relevant hits inside the deep semantic pool the deep default would filter out, and how far hit@3 drops when the quick default filters the ranking. With `--baseline <report>` naming an earlier `--stats` report, the runner SHALL additionally record, for each default the current profile defines, the threshold on the current profile's population that reproduces the baseline report's pass rate. It SHALL refuse a baseline that lacks one of those defaults or measured one on a different population, before embedding any query. Without `--stats` the report SHALL NOT carry these fields.

#### Scenario: Pass rates per default

- **WHEN** the runner is invoked with `--stats`
- **THEN** the report carries quantiles for each of the seven distributions and, for each measured similarity default of the selected profile, the fraction of its unranked population at or above it

#### Scenario: A profile without a fallback has no fallback pass rate

- **WHEN** the runner is invoked with `--stats` under a profile that defines no fallback
- **THEN** the report's pass rates carry no `fallback` entry, and a `--baseline` whose report has one is accepted

#### Scenario: A baseline yields suggested thresholds

- **WHEN** the runner is invoked with `--stats --baseline <report>` where the baseline report's `deep` default passed 90 % of its population
- **THEN** the report's suggested `deep` threshold is the value at which 90 % of the current profile's query↔every-note similarities pass

#### Scenario: A baseline measured on another population is refused

- **WHEN** the runner is invoked with `--stats --baseline <report>` where the baseline report measured `deep` on the ranked query candidates
- **THEN** the run fails before embedding any query, naming the file, the default and both populations

#### Scenario: Statistics are opt-in

- **WHEN** the runner is invoked without `--stats`
- **THEN** the report carries no distribution fields
