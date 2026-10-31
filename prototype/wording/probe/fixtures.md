## Fixture 1 — a `search_notes` response

```json
{ "matches": [
  { "path": "projects/onboarding.md", "found_in": ["semantic", "lexical:body"], "similarity": 0.58,
    "blocks": [
      { "heading": "", "lines": [15, 16], "similarity": 0.55 },
      { "heading": "Decisions", "lines": [23, 27], "similarity": 0.49 } ],
    "lexical": [ { "matched_in": "body", "snippet": "…gate exports behind the paid plan…", "lines": [25, 25], "heading": "Decisions" } ] },
  { "path": "logs/2026.md", "found_in": ["lexical:body"],
    "lexical": [ { "matched_in": "body", "snippet": "…the retry budget ran out…", "lines": [188, 188], "heading": "Notes" } ] }
], "truncated": false }
```

## Fixture 2 — `read_notes({ paths: ["projects/onboarding.md", "logs/2026.md"] })`

```json
{ "results": [
  { "path": "projects/onboarding.md",
    "frontmatter": { "type": "project", "status": "active" },
    "lines": [5, 41],
    "content": "**Owner:** Dana · **Due:** 2026-12-01\n\n| Field | Value |\n|---|---|\n| Tier | free |\n| Seats | 12 |\n| Region | EU |\n| Plan | trial |\n\n## First 30 days\n\nPair every new hire with a buddy for the first two weeks; the buddy owns the checklist.\n\n### Week 1\n\n- laptop, accounts, repo access\n- …",
    "truncated": true,
    "preamble": [5, 13],
    "outline": [
      { "heading": "First 30 days", "level": 2, "lines": [14, 22] },
      { "heading": "Week 1", "level": 3, "lines": [18, 22] },
      { "heading": "Decisions", "level": 2, "lines": [23, 27] },
      { "heading": "Open questions", "level": 2, "lines": [28, 31] },
      { "heading": "Snippets", "level": 2, "lines": [32, 41] } ] },
  { "path": "logs/2026.md",
    "frontmatter": { "type": "resource", "created": "2026-01-01" },
    "lines": [5, 1225],
    "content": "# Work log\n\n## 2026-01\n\n### Week 1\n\n#### Notes\n\n- set up the staging box; DNS took a day…",
    "truncated": true,
    "outline": [
      { "heading": "Work log", "level": 1, "lines": [5, 1225] },
      { "heading": "2026-01", "level": 2, "lines": [7, 111], "hidden": 9 },
      { "heading": "2026-02", "level": 2, "lines": [112, 212], "hidden": 8 },
      { "heading": "2026-03", "level": 2, "lines": [213, 320], "hidden": 9 } ],
    "collapsed": true }
], "count": 2, "errors": 0 }
```

## Fixture 3 — a later call with four items

```json
{ "results": [
  { "path": "projects/onboarding.md", "frontmatter": { "type": "project", "status": "active" },
    "heading": "Decisions", "level": 2, "lines": [23, 27],
    "content": "## Decisions\n\n- Keep the free tier.\n- Gate exports behind the paid plan.\n" },
  { "path": "projects/onboarding.md",
    "error": { "code": "HEADING_NOT_FOUND", "message": "No heading block named 'Risks' in projects/onboarding.md; use a heading name from 'outline'" },
    "lines": [5, 41],
    "outline": [
      { "heading": "First 30 days", "level": 2, "lines": [14, 22] },
      { "heading": "Week 1", "level": 3, "lines": [18, 22] },
      { "heading": "Decisions", "level": 2, "lines": [23, 27] },
      { "heading": "Open questions", "level": 2, "lines": [28, 31] },
      { "heading": "Snippets", "level": 2, "lines": [32, 41] } ] },
  { "path": "logs/2026.md",
    "error": { "code": "AMBIGUOUS_MATCH", "message": "Heading 'Notes' matches 3 heading blocks in logs/2026.md (lines 11–30, 140–151, 186–195); read one with { path, lines: [start, end] }" },
    "matches": [
      { "heading": "Notes", "level": 4, "lines": [11, 30] },
      { "heading": "Notes", "level": 4, "lines": [140, 151] },
      { "heading": "Notes", "level": 4, "lines": [186, 195] } ] },
  { "path": "projects/onboarding.md",
    "error": { "code": "LINES_OUT_OF_RANGE", "message": "Lines [50, 60] share no line with the body of projects/onboarding.md (body: lines 5–41)" },
    "lines": [5, 41] }
], "count": 4, "errors": 3 }
```

## Fixture 4 — a heading read of a lexical hit

A `search_notes` lexical hit on `specs/api.md` had `"lines": [88, 90], "heading": "Examples"`.
`read_notes({ paths: [{ path: "specs/api.md", heading: "Examples" }] })` returned:

```json
{ "path": "specs/api.md", "frontmatter": {}, "heading": "Examples", "level": 2, "lines": [40, 52], "content": "## Examples\n\n…" }
```
