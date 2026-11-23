# mend: one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats —
a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor
tool calls as JSON — and this one tool reads all four to the single specification in `SPEC.md`, finds the
lines each edit names even when the model drifted their whitespace or indentation, and changes every file
or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory; when absent or `-`, the patch
  is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`, `json`, or `auto`
  (the default, which detects it).
- `--check` does everything but write: the same output and exit code as without it, and no file is
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`) and `ok: <n> files`.
Exit 1 lists each failed edit (`error: <code> <path>`) and `failed: <k> of <n> edits`; nothing is
written. Exit 2 prints one error line (`error: usage`, `error: no-patch`, `error: format`, or
`error: parse <N>`).

## Matching

Old lines are found at the first of three tiers at which they occur at least once: exact, then ignoring
trailing spaces and tabs, then ignoring leading and trailing spaces and tabs. At the third tier, new
lines are re-indented to the file's own indentation. A unified hunk takes the occurrence nearest to its
header's line number; a SEARCH/REPLACE block needs exactly one occurrence; a V4A chunk takes the first
occurrence at or after its cursor (past its anchor, when it has one).

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs
  `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts <practice.json>
      node check.ts <practice.json> u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification — the whole contract.
- `LICENSE`: MIT.

## Verifying

Run the 100 public practice checks from the repository root with the kit's practice set:

    node check.ts ../program/generator/practice.json

`100 of 100 passed: practice score 1000` is the target. The scored checks are drawn after the deadline
from a sealed pool, so the practice set is a floor, not a ceiling: read SPEC.md sentence by sentence.
