# Hybrid Search Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace semantic-first vault guidance with compact routing guidance that tells agents when to start with structural lookup versus semantic search, then validate that behavior before updating the vault-level `AGENTS.md`.

**Architecture:** Keep runtime behavior unchanged and move the change into guidance surfaces. Update injected MCP server instructions in `src/server.ts`, align public docs in `README.md`, manually smoke-test the new routing behavior, and only then simplify the vault-local override in `/Users/amostovenko/Obsidian/AGENTS.md`.

**Tech Stack:** TypeScript, Node.js, MCP server instructions, Markdown docs, manual smoke testing

---

### Task 1: Rework Injected MCP Routing Guidance

**Files:**
- Modify: `src/server.ts`
- Verify: `src/server.ts`

- [ ] **Step 1: Replace the semantic-first instruction outline with router-first guidance**

Edit `SERVER_INSTRUCTIONS` in `src/server.ts` so it introduces a compact `## Search routing` section with these ideas:

```text
## Search routing

If the user gives an exact anchor and structural tools are available, start there first.
Prefer Obsidian CLI when available for exact note, path, date, tag, property, and link lookups.
If Obsidian CLI is unavailable, use other structural file or navigation tools available in the current environment.

Use search_notes when the user is recalling a topic fuzzily, asking a conceptual question, or does not know the exact note name.
Use get_similar_notes to expand semantically related context after a relevant note is found.

Structural anchors include:
- exact note title or filename
- explicit path or folder
- daily note by date or relative date
- tag, property, or wikilink
- backlinks or link traversal
```

- [ ] **Step 2: Keep retrieval guidance only for the semantic path**

Retain the useful query-writing and mode-selection instructions, but make them subordinate to routing by introducing them after the routing section. The flow should read like:

```text
1. Choose the search class first: structural or semantic
2. If semantic is the right path, write the query and choose the mode
```

Expected result:
- `quick` / `deep` guidance still exists
- threshold fallback guidance still exists
- semantic expansion guidance still exists
- the text no longer implies that every vault lookup should begin with `search_notes`

- [ ] **Step 3: Tighten tool descriptions so they match the routing story**

Update the `search_notes` and `get_similar_notes` tool descriptions in `src/server.ts` to reinforce the new boundary:

```text
search_notes:
Search notes by semantic similarity for fuzzy recall, topic lookup, or cross-language matching.

get_similar_notes:
Find semantically related notes after you already have a relevant note path.
```

Expected result:
- `search_notes` no longer reads like the universal first tool
- `get_similar_notes` is framed as semantic expansion rather than structural traversal

- [ ] **Step 4: Run a focused diff review**

Run:

```bash
git diff -- src/server.ts
```

Expected:
- `SERVER_INSTRUCTIONS` now opens with routing guidance
- semantic retrieval instructions remain present but clearly secondary

- [ ] **Step 5: Commit checkpoint**

Run:

```bash
git add src/server.ts
git commit -m "docs: add hybrid search routing guidance"
```

Expected:
- a commit exists for the injected MCP guidance update only

### Task 2: Align README With The New Routing Model

**Files:**
- Modify: `README.md`
- Verify: `README.md`

- [ ] **Step 1: Update the product framing near the top of the README**

Adjust early README language so it no longer presents Neuro Vault MCP as the default first hop for every vault query. Keep the package described as semantic search, but clarify that agents may combine semantic search with structural tools.

Suggested shape:

```markdown
Neuro Vault MCP provides semantic vault search and semantic expansion.
Agents should combine it with structural tools for exact note, path, date, tag, and link lookups when those tools are available.
```

- [ ] **Step 2: Add a dedicated routing section**

Insert a `## Search Routing` or `## Search Routing Philosophy` section before the detailed tool reference.

Include:
- structural first for exact file/title/path/daily/tag/property/link requests
- semantic first for fuzzy topic recall and related-note discovery
- explicit separation of `tool routing` and `retrieval policy`

Example content:

```markdown
Tool routing decides whether to start with structural lookup or semantic search.
Retrieval policy decides how `search_notes` behaves after semantic search is chosen.
```

- [ ] **Step 3: Replace the README snippet with a minimal local override**

Rewrite the `AGENTS.md / CLAUDE.md Snippet` section so it is intentionally short:

```markdown
## Vault search

Use vault-aware tools when vault context matters.
Do not guess about note contents when the vault can be searched.
Core routing logic comes from the Neuro Vault MCP server instructions.
```

Expected result:
- the snippet no longer duplicates the decision tree
- local config becomes a light reminder instead of a second policy source

- [ ] **Step 4: Review the README diff for contradictions**

Run:

```bash
git diff -- README.md
```

Check for:
- no leftover “use search_notes first” language
- no confusion between backlinks and semantically related notes
- no claim that routing is enforced

- [ ] **Step 5: Commit checkpoint**

Run:

```bash
git add README.md
git commit -m "docs: explain hybrid vault search routing"
```

Expected:
- a second commit exists for public documentation updates

### Task 3: Validate Routing Behavior Manually

**Files:**
- Verify: `src/server.ts`
- Verify: `README.md`

- [ ] **Step 1: Build the project to catch syntax or formatting regressions**

Run:

```bash
npm run build
```

Expected:
- TypeScript compiles successfully

- [ ] **Step 2: Run the test suite as a regression check**

Run:

```bash
npm run test
```

Expected:
- existing tests pass unchanged

- [ ] **Step 3: Smoke-test the routing guidance against exact-anchor prompts**

Use at least these prompts in a real MCP client session or equivalent manual evaluation:

```text
Open Project X
Show yesterday's daily note
What links to this note?
```

Expected:
- the agent starts with structural lookup rather than `search_notes`

- [ ] **Step 4: Smoke-test the routing guidance against fuzzy semantic prompts**

Use at least these prompts:

```text
What did I write about agent orchestration?
Which idea did I have about local-first AI?
Find related notes for this topic
```

Expected:
- the agent starts with `search_notes`
- once a relevant note is found, the agent can use `get_similar_notes` for expansion

- [ ] **Step 5: Record the validation outcome in the working notes or final summary**

Capture:
- which prompts were used
- whether routing matched expectations
- whether anything still biases too strongly toward semantic search

Expected:
- clear evidence that the package guidance is good enough before changing the vault-local override

### Task 4: Simplify The Vault-Level Override After Validation

**Files:**
- Modify: `/Users/amostovenko/Obsidian/AGENTS.md`
- Verify: `/Users/amostovenko/Obsidian/AGENTS.md`

- [ ] **Step 1: Replace the hard MCP-first phrasing in `## Vault access`**

Update the section so it no longer says to prefer `neuro-vault-mcp` whenever available. Replace it with a compact statement that:
- treats MCP server instructions as the primary routing source
- keeps Obsidian CLI preferred for structural vault work
- keeps the “do not guess” rule

Suggested direction:

```markdown
When answering questions about this vault, follow the routing guidance from Neuro Vault MCP server instructions when the MCP is available.
Prefer Obsidian CLI for exact note, path, daily note, tag, property, and link traversal work.
Use semantic vault search for fuzzy recall and related-note discovery.
```

- [ ] **Step 2: Preserve only vault-specific local guidance**

Keep local rules that are genuinely vault-specific, such as:
- Ukrainian as the main vault language
- PARA structure
- note-creation conventions

Remove duplicate generic routing rules that now belong to the package.

- [ ] **Step 3: Review the vault override diff carefully**

Run:

```bash
git diff -- /Users/amostovenko/Obsidian/AGENTS.md
```

Expected:
- the section is shorter
- there is no semantic-first duplication left
- local vault policy still reads clearly on its own

- [ ] **Step 4: Commit checkpoint**

If `/Users/amostovenko/Obsidian` is version-controlled and this change should be committed, run the appropriate `git add` / `git commit` there. If it is not version-controlled, include the exact text change in the final handoff instead.

Expected:
- the local override is updated only after smoke validation succeeds

### Task 5: Final Verification And Handoff

**Files:**
- Verify: `src/server.ts`
- Verify: `README.md`
- Verify: `/Users/amostovenko/Obsidian/AGENTS.md`

- [ ] **Step 1: Review the final combined diff**

Run:

```bash
git diff -- src/server.ts README.md docs/superpowers/specs/2026-04-23-hybrid-search-routing-design.md docs/superpowers/plans/2026-04-23-hybrid-search-routing-implementation.md
```

If `/Users/amostovenko/Obsidian/AGENTS.md` is version-controlled separately, review its diff in that workspace too.

- [ ] **Step 2: Summarize what changed and what did not**

Final summary must explicitly say:
- routing guidance changed
- retrieval policy behavior did not change
- no dedicated instruction-string tests were added
- vault-local override was updated only after manual validation

- [ ] **Step 3: Hand off with verification evidence**

Include:
- build result
- test result
- manual smoke-test prompts and outcomes
- any remaining caveat that instructions are advisory, not enforceable
