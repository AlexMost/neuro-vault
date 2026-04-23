# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

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
