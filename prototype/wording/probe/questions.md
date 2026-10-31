Answer each question. Where a tool call is asked for, give the exact JSON arguments.

1. **Rung choice.** You know nothing about `logs/2026.md` except that it is long. You want to know what it covers before reading any of it. Which single `read_notes` call do you make?
2. **Default.** What does `read_notes({ paths: ["a.md", { "path": "b.md", "heading": "Plan" }] })` return for each item — which content mode, and why?
3. **Heading read.** From Fixture 2, give the call that reads only the "Decisions" part of `projects/onboarding.md`.
4. **Own text.** From Fixture 2, which lines hold the own text of "First 30 days" (its text before any sub-heading)? Give the call that reads exactly those lines.
5. **`hidden`.** In Fixture 2, what does `"hidden": 9` on "2026-01" count — lines, characters, notes or headings? Give the call that lists what it hides.
6. **Collapsed vs prefix.** The `logs/2026.md` preview `content` shows `### Week 1` and `#### Notes`, but its outline lists neither. Is the outline wrong? Explain.
7. **Coordinates.** In Fixture 2, on which line does the frontmatter of `projects/onboarding.md` end? Is the first line of its `content` file line 1?
8. **Semantic block without a heading.** Fixture 1's first `blocks[]` entry has `"heading": ""`. Give the call that reads it.
9. **Lexical body hit.** Give the call that reads the `logs/2026.md` lexical hit in Fixture 1. Would `{ "path": "logs/2026.md", "heading": "Notes" }` be a safe alternative? Why?
10. **Enclosing heading block.** You want the whole heading block that contains Fixture 1's first `blocks[]` hit (lines 15–16), not just those lines. Using only Fixture 2, which heading block is it, and what call reads it?
11. **HEADING_NOT_FOUND.** In Fixture 3, the second item asked for "Risks". What do you do next?
12. **AMBIGUOUS_MATCH.** In Fixture 3, the third item. You wanted the "Notes" that contains Fixture 1's lexical hit (line 188). Give the next call.
13. **LINES_OUT_OF_RANGE.** In Fixture 3, the fourth item. Why did it miss, and what range is valid?
14. **Frontmatter on a miss.** The miss items in Fixture 3 carry no `frontmatter`. Does that mean those notes have no frontmatter?
15. **Silent mismatch.** Fixture 4: is the returned text the passage the search hit pointed at? What do you do next?
