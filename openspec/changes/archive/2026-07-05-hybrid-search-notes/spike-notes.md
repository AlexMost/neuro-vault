# Spike: mdast-util-from-markdown parser validation

Spike run: Task 1 parser dependency.

Tested `mdast-util-from-markdown` against hard-wrapped paragraph + heading + code fence (input shown in a 4-backtick fence so the inner 3-backtick fence renders):

````
# H1

векторний
пошук у vault

```
# not a heading
```
````

Output (node type, start line, end line):
```
heading 1 1
paragraph 3 4
code 6 8
```

Result: mdast-util-from-markdown confirmed: block nodes + line positions; markdown-it fallback not needed.
