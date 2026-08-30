# Tasks — single-vault-dispatch-builder

## 1. Builder

- [ ] 1.1 Add `src/lib/single-vault-tool.ts`: `ISingleVaultToolSpec` / `ISemanticVaultToolSpec` discriminated on `semantic`, `inputShape: z.ZodRawShape & { vault?: never }`, and `buildSingleVaultTool(registry, spec)` contributing the `vault` param, appending the explicit-vault block as the description's final paragraph, and resolving via `resolveVault` / `resolveSemanticVault`
- [ ] 1.2 Add `test/lib/single-vault-tool.test.ts` through the registration gate (`registerTool` + `callTool`/`expectToolError`): `VAULT_REQUIRED` code + `details` on omitted vault in multi-vault mode, named-vault targeting, unknown-vault failure, single-vault fallthrough, `vault` advertised in multi / absent in single mode, suffix-last final paragraph, `semantic: true` readiness-gate routing

## 2. Migrate the seven operations tools

- [ ] 2.1 Migrate `read_notes`, `edit_note`, `read_daily`, `set_property`, `remove_property` to `buildSingleVaultTool` — description words byte-identical (the suffix term was already last)
- [ ] 2.2 Migrate `create_note`, moving the post-suffix overwrite sentence into the domain description tail (words unchanged, position fixed)
- [ ] 2.3 Migrate `get_note_links`, unfolding the suffix out of its `.join('\n')` array
- [ ] 2.4 Fix any exact-string / ordering description assertions the migrations surface (regex-based phrase assertions must pass untouched — an untouched failure is a wording regression: fix the source)

## 3. Migrate the two semantic tools

- [ ] 3.1 Migrate `find_duplicates` and `get_similar_notes` with `semantic: true`; typed `entry.backend` stays cast-free

## 4. Description composition cleanup (both builders)

- [ ] 4.1 Drop the leading-space wrapping from `describeMultiVault` (return the bare block); update `src/lib/vault-param.ts` doc comments and `test/lib/vault-param.test.ts`
- [ ] 4.2 In `buildMultiVaultTool`, delete the `spec.description.includes('\n')` separator branch and always append `'\n\n' + block`; drop the transitional `.trimStart()` in `buildSingleVaultTool`; update the exact-string assertions in `test/lib/multi-vault-tool.test.ts`

## 5. Boundary and docs

- [ ] 5.1 Add the ESLint `no-restricted-imports` override for `src/modules/**` banning `lib/vault-param.js` and `lib/resolve-vault.js`; probe with the verbatim `npm run lint` (temporary offending import must fail it, then revert the probe)
- [ ] 5.2 Word-wise (whitespace-insensitive) description diff against `main` — only `create_note`'s repositioned overwrite sentence may differ
- [ ] 5.3 Update `docs/architecture/fan-out.md` for the two-builder split and paragraph placement, then sweep all of `docs/` for `vaultParamShape` / `describeMultiVault` / `resolveVault` / `EXPLICIT_VAULT_SUFFIX` mentions describing the old hand-rolled composition

## 6. Verification and delivery

- [ ] 6.1 `npm test && npm run lint && npm run typecheck && npm run build` all green; verify → retrospective → archive → push branch and `gh pr create` with `Closes #111`
