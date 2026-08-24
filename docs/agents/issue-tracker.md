# Issue tracker: GitHub

Issues for this repo live as GitHub issues. Use the `gh` CLI for all operations.
Language: **English** — issues are public.

## Conventions

- Create: `gh issue create --title "..." --body "..."` (heredoc, or `--body-file`, for multi-line)
- Read: `gh issue view <n> --comments` · List: `gh issue list --state open`
- Comment / label / close: `gh issue comment <n>` · `gh issue edit <n> --add-label` · `gh issue close <n>`

`#N` shares a number space with PRs — resolve with `gh pr view <n>` first, fall back to `gh issue view <n>`.

## Coverage

- **Every opsx change is tracked by an issue.** No exceptions — [`.claude/rules/opsx-routing.md`](../../.claude/rules/opsx-routing.md) already filters trivia into direct PRs, so anything that reaches opsx is worth a row on the board.
- **A direct PR gets an issue when the work was planned ahead**, not when it was done on sight. Typo, dep bump, lint tweak: no issue.

The rule is about intent, not size — size thresholds rot, "did I plan this or just do it" does not. The worst case is a surplus issue, closed in one click.

## Linking

- The issue names its change by **slug**: ``OpenSpec change: `unified-vault-scope` ``.
  **Never a path** — `npx openspec archive` moves the directory into `openspec/changes/archive/<date>-<slug>/` at step 9, *before* the PR exists, so any path recorded up front is already dead.
- `proposal.md` carries `Tracked by: #<n>` on its first line.
- PRs: `Closes #<n>` in the **last** PR of a change; `Refs #<n>` in earlier ones. A change may span two PRs — closing too early breaks the epic's progress bar.

## Efforts

A multi-change effort (3+ slices) gets an **epic** issue labelled `effort`; its changes are **sub-issues** of it, which is what renders the progress bar. Two issues do not warrant an epic.

```bash
# add a sub-issue (sub_issue_id is the child's numeric database id)
gh api repos/{owner}/{repo}/issues/{epic}/sub_issues -F sub_issue_id=$(gh api repos/{owner}/{repo}/issues/{child} --jq .id)
```

**Ordering between issues uses GitHub's native `blocked_by`** — this is the authoritative representation of dependencies, not a diagram in a doc:

```bash
gh api --method POST repos/{owner}/{repo}/issues/{child}/dependencies/blocked_by \
  -F issue_id=$(gh api repos/{owner}/{repo}/issues/{blocker} --jq .id)
```

`issue_id` is the blocker's numeric **database id** (`gh api repos/{owner}/{repo}/issues/<n> --jq .id`) — not `#number`, not `node_id`. An issue is takeable when `issue_dependencies_summary.blocked_by` is `0`.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue labelled `wayfinder:map`; its tickets are sub-issues of it, labelled `wayfinder:research` / `wayfinder:prototype` / `wayfinder:grilling` / `wayfinder:task`. Blocking uses the same native `blocked_by` edges as above. The **frontier** is the map's open sub-issues with zero open blockers and no assignee; first in map order wins. Claim with `gh issue edit <n> --add-assignee @me` before any other work.

## Privacy

Issues, PRs and repo docs **never name private vault paths or note titles**. Describe provenance neutrally — "source: private vault task note". Illustrative vault paths in product documentation (`docs/guide/`) are fine; they document the product, not anyone's notes.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo starts treating external PRs as feature requests; `/triage` reads this flag.)_
