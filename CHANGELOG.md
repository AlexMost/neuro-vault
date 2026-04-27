# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [3.0.0](https://github.com/AlexMost/neuro-vault/compare/v1.7.0...v3.0.0) (2026-04-27)

### ⚠ BREAKING CHANGES

- get_tag is gone. Clients listing notes by a single tag
  should call query_notes({ filter: { tags: '<name>' } }) instead. The
  leading '#' strip that get_tag did is now the client's responsibility
  (e.g. tag.replace(/^#/, '')). This also removes the obsidian-cli 'tag'
  subcommand path and the TAG_NOT_FOUND error code; nothing else throws it.

query_notes reads from disk via FsVaultReader, so this also shrinks the
surface that requires Obsidian to be running.

Spec: docs/superpowers/specs/2026-04-27-remove-get-tag-design.md

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

- **semantic:** search_notes no longer accepts expansion or
  expansion_limit. Use mode to control expansion behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

- get_similar_notes now takes \`path\` instead of \`note_path\`,
  matching every other tool that accepts a vault-relative path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

- get_tag now takes `tag` instead of `name`. Frees `name`
  to mean "note identifier" consistently across the API.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

- set_property, read_property, remove_property now take
  `name`/`path` for the note identifier (mirroring read_note/edit_note) and
  `key` for the frontmatter property name. The previous `file` and `name`
  (as property key) are no longer accepted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

- feat!(operations): remove get_tag tool — covered by query_notes ([d94e957](https://github.com/AlexMost/neuro-vault/commit/d94e95753b51258397e2e906ef0c02e27e109bc7))

### Features

- **operations:** add query_notes tool for structured frontmatter queries ([1184c81](https://github.com/AlexMost/neuro-vault/commit/1184c816a0d4367a1676cb8f9b632512b12d2849))
- **operations:** add VaultReader interface and FsVaultReader ([46011a1](https://github.com/AlexMost/neuro-vault/commit/46011a11b877cef60f57836ebc438682933228c3))
- **operations:** replace read_note with batch read_notes ([1993725](https://github.com/AlexMost/neuro-vault/commit/1993725000cfdc8c3b9a01c675c431d6b0ac0b9f))
- rename get_similar_notes input param (note_path→path) ([cc882d4](https://github.com/AlexMost/neuro-vault/commit/cc882d4193f8ba9af53251f7aaa82ee6690a9251))
- rename get_tag input param (name→tag) ([c00fa5d](https://github.com/AlexMost/neuro-vault/commit/c00fa5d68ec5b0ed78101c877e8a8e338dbe4167))
- rename property tool params (file→name, name→key) ([d989a02](https://github.com/AlexMost/neuro-vault/commit/d989a02f3aae864a8d787fe1b0ae2e6120ddeedf))
- **semantic:** drop expansion params from search_notes public schema ([ad80083](https://github.com/AlexMost/neuro-vault/commit/ad80083733a22a59247689adad384fc9422dfe65))

### Bug Fixes

- **operations:** return real path and parsed frontmatter from read_note ([cc5400a](https://github.com/AlexMost/neuro-vault/commit/cc5400a272431801634e66b2e167f0146d4443de))
- **semantic:** honor user-supplied limit in executeRetrieval ([52baa52](https://github.com/AlexMost/neuro-vault/commit/52baa527f548216c1878cfe66a700383216054aa))
- **server:** correct read_notes routing anchor and dash style ([bb370c8](https://github.com/AlexMost/neuro-vault/commit/bb370c814b14b07de1eabe81e955727235fd0253))
- **vault-reader:** disable symlink following in scan to prevent loops ([24d9b22](https://github.com/AlexMost/neuro-vault/commit/24d9b2259232bedf924fe006bc2ea029e9e08aab))

## [2.0.0](https://github.com/AlexMost/neuro-vault/compare/v1.7.2...v2.0.0) (2026-04-27)

### ⚠ BREAKING CHANGES

- **semantic:** search_notes no longer accepts expansion or
  expansion_limit. Use mode to control expansion behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

- get_similar_notes now takes \`path\` instead of \`note_path\`,
  matching every other tool that accepts a vault-relative path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

- get_tag now takes `tag` instead of `name`. Frees `name`
  to mean "note identifier" consistently across the API.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

- set_property, read_property, remove_property now take
  `name`/`path` for the note identifier (mirroring read_note/edit_note) and
  `key` for the frontmatter property name. The previous `file` and `name`
  (as property key) are no longer accepted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

### Features

- **operations:** add VaultReader interface and FsVaultReader ([46011a1](https://github.com/AlexMost/neuro-vault/commit/46011a11b877cef60f57836ebc438682933228c3))
- **operations:** replace read_note with batch read_notes ([1993725](https://github.com/AlexMost/neuro-vault/commit/1993725000cfdc8c3b9a01c675c431d6b0ac0b9f))
- rename get_similar_notes input param (note_path→path) ([cc882d4](https://github.com/AlexMost/neuro-vault/commit/cc882d4193f8ba9af53251f7aaa82ee6690a9251))
- rename get_tag input param (name→tag) ([c00fa5d](https://github.com/AlexMost/neuro-vault/commit/c00fa5d68ec5b0ed78101c877e8a8e338dbe4167))
- rename property tool params (file→name, name→key) ([d989a02](https://github.com/AlexMost/neuro-vault/commit/d989a02f3aae864a8d787fe1b0ae2e6120ddeedf))
- **semantic:** drop expansion params from search_notes public schema ([ad80083](https://github.com/AlexMost/neuro-vault/commit/ad80083733a22a59247689adad384fc9422dfe65))

### Bug Fixes

- **semantic:** honor user-supplied limit in executeRetrieval ([52baa52](https://github.com/AlexMost/neuro-vault/commit/52baa527f548216c1878cfe66a700383216054aa))
- **server:** correct read_notes routing anchor and dash style ([bb370c8](https://github.com/AlexMost/neuro-vault/commit/bb370c814b14b07de1eabe81e955727235fd0253))

## [1.7.2](https://github.com/AlexMost/neuro-vault/compare/v1.7.1...v1.7.2) (2026-04-27)

## [1.7.1](https://github.com/AlexMost/neuro-vault/compare/v1.7.0...v1.7.1) (2026-04-27)

### Bug Fixes

- **operations:** return real path and parsed frontmatter from read_note ([cc5400a](https://github.com/AlexMost/neuro-vault/commit/cc5400a272431801634e66b2e167f0146d4443de))

## [1.7.0](https://github.com/AlexMost/neuro-vault/compare/v1.6.0...v1.7.0) (2026-04-27)

### Features

- **semantic:** accept query array in search_notes Zod schema ([e064ddd](https://github.com/AlexMost/neuro-vault/commit/e064ddd5c4142d0a2a762546cd4a73d8c7b66ed7))
- **semantic:** add executeMultiRetrieval with merge by path ([74aaf03](https://github.com/AlexMost/neuro-vault/commit/74aaf030c48b98cfc8c3afef178596e1cbbf7dce))
- **semantic:** handle string|string[] in searchNotes with merge ([7fdaf4e](https://github.com/AlexMost/neuro-vault/commit/7fdaf4ee2da44806c9427d9878e5432499567d14))
- **semantic:** widen SearchNotesInput.query to string|string[] ([f8b88fb](https://github.com/AlexMost/neuro-vault/commit/f8b88fbbd807cc58ef2f52d4eebfb240828b11d9))

### Bug Fixes

- **semantic:** drop search results whose paths no longer exist on disk ([7fd2e19](https://github.com/AlexMost/neuro-vault/commit/7fd2e192e3bdc29a6c7720184d6a1d14ff82529d))
- **server:** correct backtick escaping in SERVER_INSTRUCTIONS ([4036fea](https://github.com/AlexMost/neuro-vault/commit/4036fea5dfd98f66e7c39215b234329db38085a7))

## [1.6.0](https://github.com/AlexMost/neuro-vault/compare/v1.5.0...v1.6.0) (2026-04-26)

### Features

- **operations:** add getTag with verbose/total CLI modes ([4654e17](https://github.com/AlexMost/neuro-vault/commit/4654e17628dc24c20cb28dedb927de6ab92b07f6))
- **operations:** add listProperties via CLI properties command ([0794e71](https://github.com/AlexMost/neuro-vault/commit/0794e712eb0cef4c6d88bf13524e820cc0c15656))
- **operations:** add listTags via CLI tags command ([a41c31a](https://github.com/AlexMost/neuro-vault/commit/a41c31ae03cdf51e422ec22de9d1080529ee2032))
- **operations:** add readProperty with value parsing and PROPERTY_NOT_FOUND ([6db611c](https://github.com/AlexMost/neuro-vault/commit/6db611c6790421997d691524f42616b27ce94dbf))
- **operations:** add removeProperty (idempotent on missing property) ([5922043](https://github.com/AlexMost/neuro-vault/commit/5922043fcacaa5f7e04500985e56585495b5b03b))
- **operations:** add setProperty to VaultProvider ([a0a7f61](https://github.com/AlexMost/neuro-vault/commit/a0a7f6153d4434990b25bed7240a7f934ae58e12))
- **operations:** list_properties, list_tags, get_tag handlers ([6645faa](https://github.com/AlexMost/neuro-vault/commit/6645faac5921da459a1ca3c5493e034354be2194))
- **operations:** read_property handler ([6c56533](https://github.com/AlexMost/neuro-vault/commit/6c5653367563637bd3c17b2d8018368266f9e71f))
- **operations:** register 6 properties/tags MCP tools ([9fcb6c6](https://github.com/AlexMost/neuro-vault/commit/9fcb6c610926002fb3f1ff881f1242302d997884))
- **operations:** remove_property handler (idempotent) ([eccec61](https://github.com/AlexMost/neuro-vault/commit/eccec612c38d1c45af687842d31952c9c685490e))
- **operations:** set_property handler with type inference ([ec47653](https://github.com/AlexMost/neuro-vault/commit/ec47653ee48b9158089da6c829e3aee1bb101f83))

### Bug Fixes

- **operations:** distinguish CLI parser failure from TAG_NOT_FOUND in getTag ([1c6f7f5](https://github.com/AlexMost/neuro-vault/commit/1c6f7f56cc1d9668427e1276256bc65e42015c91))
- **operations:** smoke-test fixes for set_property date and get_tag parser ([3d613a7](https://github.com/AlexMost/neuro-vault/commit/3d613a732d564ef22d3fecc55257363cbd703e22)), closes [#year2026](https://github.com/AlexMost/neuro-vault/issues/year2026)

## [1.5.0](https://github.com/AlexMost/neuro-vault/compare/v1.4.1...v1.5.0) (2026-04-25)

### Features

- **config:** add --semantic / --operations / --obsidian-cli flags ([ca56876](https://github.com/AlexMost/neuro-vault/commit/ca568761b605d80e43bd940e83c5335149dbfcb9))
- **operations:** add tool handlers with readNote ([ebb8825](https://github.com/AlexMost/neuro-vault/commit/ebb8825b17e8bbe356582e5c19997271b163b7d9))
- **operations:** default ObsidianCLIProvider to real execFile ([4238729](https://github.com/AlexMost/neuro-vault/commit/4238729630e14658e6e1960ffd22397376290f39))
- **operations:** define error codes and tool input types ([86ce189](https://github.com/AlexMost/neuro-vault/commit/86ce1899bc369f89948f4d3b342474fe21b983c0))
- **operations:** define VaultProvider interface ([a373b3a](https://github.com/AlexMost/neuro-vault/commit/a373b3a1d0e2fcbfdd5b53b386fa16391ea4a5d8))
- **operations:** export createOperationsModule ([202c473](https://github.com/AlexMost/neuro-vault/commit/202c473edc7b577ea469227362e371a2bf96e3d3))
- **operations:** implement createNote ([ea5201b](https://github.com/AlexMost/neuro-vault/commit/ea5201b17e36383c6f4538231ef4e768dae1efb9))
- **operations:** implement createNote handler ([da509f1](https://github.com/AlexMost/neuro-vault/commit/da509f1390612b6048bfb6da4585cbd5b18a0159))
- **operations:** implement edit/read-daily/append-daily handlers ([a241706](https://github.com/AlexMost/neuro-vault/commit/a24170603394a8352d1536b57e22cfa9f4f7e360))
- **operations:** implement editNote ([06d8c6e](https://github.com/AlexMost/neuro-vault/commit/06d8c6e5b7d6695b0e8175af991607a345a75f7a))
- **operations:** implement readDaily and appendDaily ([633364c](https://github.com/AlexMost/neuro-vault/commit/633364c1bf639f8768c28f28b6d54326ca3f37ff))
- **operations:** map CLI failures to ToolHandlerError codes ([a00cc57](https://github.com/AlexMost/neuro-vault/commit/a00cc577ce7a0cce6d4776f55ff24699baac5d71))
- **operations:** register 5 vault operation tools ([cab7a66](https://github.com/AlexMost/neuro-vault/commit/cab7a660e927d10bd2b10e08dbc53a8afb084679))
- **operations:** scaffold ObsidianCLIProvider with readNote ([cea119a](https://github.com/AlexMost/neuro-vault/commit/cea119a9fc35b0bc2603a004e68a9e75e16fda3b))
- **server:** update instructions to cover operations + routing ([556da47](https://github.com/AlexMost/neuro-vault/commit/556da47c266b474faeba4df13564a0edf617e07e))
- wire operations module into server ([04e93d0](https://github.com/AlexMost/neuro-vault/commit/04e93d09db75f7c26ae5ad7f68bc16911cfee0e5))

### Bug Fixes

- **tool-response:** return text block for void handlers ([bc54b57](https://github.com/AlexMost/neuro-vault/commit/bc54b578bdeec898805fb104e9e9a4b5e66c8d7d))

## [1.4.1](https://github.com/AlexMost/neuro-vault/compare/v1.4.0...v1.4.1) (2026-04-23)

## [1.4.0](https://github.com/AlexMost/neuro-vault/compare/v1.3.1...v1.4.0) (2026-04-23)

### Features

- add block-level search to search engine ([3a0eb34](https://github.com/AlexMost/neuro-vault/commit/3a0eb345fefcb45a2057f4ce1f1a881c8bfc0d95))
- add text search fallbacks (grep + obsidian-cli) ([32844c7](https://github.com/AlexMost/neuro-vault/commit/32844c76911b3d9bb06866100c7032b4b68dcab4))
- extend types for mode-based search pipeline ([65c14dd](https://github.com/AlexMost/neuro-vault/commit/65c14dde2ad19b4506ffe5628bfb6cc1f9da6105))
- implement retrieval policy with mode defaults, multi-query, fallback, and expansion ([805d360](https://github.com/AlexMost/neuro-vault/commit/805d36098f71d32da572058f867d965058fcdbb7))
- return blockResults in quick mode scoped to matched notes ([5f4af2a](https://github.com/AlexMost/neuro-vault/commit/5f4af2a5285d0774c9e471fc445faf695cfce7a5))
- rewire search_notes to use retrieval policy with mode, multi-query, expansion ([eaa4e0d](https://github.com/AlexMost/neuro-vault/commit/eaa4e0daa4d4e3ee270c273f3feecdf3dd500af2))
- update MCP schema, tool description, and SERVER_INSTRUCTIONS for context pipeline ([102bd06](https://github.com/AlexMost/neuro-vault/commit/102bd063588e54abedcfc4a92cff5179b415e449))

### Bug Fixes

- use threshold 0 for quick-mode block search ([5b13f2f](https://github.com/AlexMost/neuro-vault/commit/5b13f2f213347d73514e7004191b9a3dfa955a35))

## [1.3.1](https://github.com/AlexMost/neuro-vault/compare/v1.3.0...v1.3.1) (2026-04-22)

### Bug Fixes

- fixed smartconnections notes parsing + instructions numeration ([a17c4bf](https://github.com/AlexMost/neuro-vault/commit/a17c4bfeac3792cc17c287851dbd9afbf0d3179d))

## [1.3.0](https://github.com/AlexMost/neuro-vault/compare/v1.2.1...v1.3.0) (2026-04-22)

### Features

- added instructions how to use this MCP + improved descriptions ([27df75e](https://github.com/AlexMost/neuro-vault/commit/27df75ebcbc44d8963b2f18aa430d8f8c5e839e5))

## [1.2.1](https://github.com/AlexMost/neuro-vault/compare/v1.2.0...v1.2.1) (2026-04-12)

### Bug Fixes

- read server version from package.json instead of hardcoding ([ca4e809](https://github.com/AlexMost/neuro-vault/commit/ca4e809007b29b8eab560f080dc21dddf923ea4b))

## [1.2.0](https://github.com/AlexMost/neuro-vault/compare/v1.1.1...v1.2.0) (2026-04-12)

### Features

- use yargs for CLI arg parsing with --help support ([a6e0ae2](https://github.com/AlexMost/neuro-vault/commit/a6e0ae2d53371d5ee9525726b289c5332ac4d706))

## [1.1.1](https://github.com/AlexMost/neuro-vault/compare/v1.1.0...v1.1.1) (2026-04-12)

### Bug Fixes

- return top 5 blocks per result without embeddings ([52daa42](https://github.com/AlexMost/neuro-vault/commit/52daa422afc11586d0e20d221cbda16c1b5d6745))
- strip embeddings and blocks from search results ([e26f8b6](https://github.com/AlexMost/neuro-vault/commit/e26f8b667a0b616acfc7898c01411b3e760e31d8))

## 1.1.0 (2026-04-11)

### Features

- add embedding service abstraction ([26223bb](https://github.com/AlexMost/neuro-vault/commit/26223bbb7da4bae1db2f9fecf5c4fe4ebb508591))
- add neuro vault MCP tool handlers ([d91ade3](https://github.com/AlexMost/neuro-vault/commit/d91ade34d4ef8c5d61361a76ee6da1adc3530206))
- add smart connections data loader ([89bbc99](https://github.com/AlexMost/neuro-vault/commit/89bbc9907ae8b50ecceedda3346586771edc7021))
- add stdio MCP server bootstrap ([b1d9c7c](https://github.com/AlexMost/neuro-vault/commit/b1d9c7c55deda57a8442ef27694e8abe120976e4))
- add typed config parsing ([2244694](https://github.com/AlexMost/neuro-vault/commit/2244694396b0212b04533186e14d75bd706e6438))
- add vector search engine ([f858a98](https://github.com/AlexMost/neuro-vault/commit/f858a9801997b4538a14d5291983a612dd26db5c))

### Bug Fixes

- defer model init so MCP transport connects immediately ([97fbe84](https://github.com/AlexMost/neuro-vault/commit/97fbe8490f1fba1de3c7a8894d65fa5512cc6597))
- enforce vault-relative loader paths ([5617c5d](https://github.com/AlexMost/neuro-vault/commit/5617c5d57f09efb7d9f2e1c4c07edfd5af092ca6))
- harden embedding service validation ([23f4c94](https://github.com/AlexMost/neuro-vault/commit/23f4c9452bccc31e2912ebec98a23cbe278130e3))
- harden smart connections loader validation ([a1e814f](https://github.com/AlexMost/neuro-vault/commit/a1e814f8a278cb7343955ade070dae1e042dcb00))
- harden tool handler validation ([d9c1249](https://github.com/AlexMost/neuro-vault/commit/d9c12492224beecee2e8096f99e19a6bd82dc772))
- normalize config paths and duplicate pair fields ([75aa818](https://github.com/AlexMost/neuro-vault/commit/75aa818ebd4d2b7431dcd35edb2fb5a6effd7fbe))
- parse real Smart Connections AJSON format ([5ff90ea](https://github.com/AlexMost/neuro-vault/commit/5ff90ea8592a4e93af3945cfd5949c9c68abb23b))
- pass pooling/normalize at call time, not pipeline creation ([ad8f677](https://github.com/AlexMost/neuro-vault/commit/ad8f6775fb6a575f23d3e71893fb40db4a08d0b0))
- remove inspector from local deps to avoid commander conflict ([12dbe4b](https://github.com/AlexMost/neuro-vault/commit/12dbe4b002ad60159684eebf1da32c502ecab772))
- stabilize search result ordering ([c23efd5](https://github.com/AlexMost/neuro-vault/commit/c23efd569eb6aa6f29c2cd3b4bc9702294bd104f))
