# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/feriyansyahlubis/mend/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/feriyansyahlubis/mend/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four
formats, and `mend` reads all four to one written specification (`SPEC.md` in the kit):

- **unified diffs** — even with wrong line numbers: hunks are matched by content at three tiers
  (exact, trailing whitespace, full whitespace), taking the occurrence nearest the hunk's line number;
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`, with the path taken
  from the nearest line above the block;
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with `Add` / `Delete` / `Update` sections,
  anchors, a cursor, and `*** End of File` chunks;
- **text-editor tool calls as JSON** — one JSON array or JSON Lines of `create` / `str_replace` /
  `insert` objects.

Every file is changed or nothing is: edits apply in order to the tree as earlier edits left it, a
failed edit changes nothing and the edits after it still run, and when any edit failed no file is
written at all. A file whose bytes are unchanged is not listed; a successful move is reported as
`R <old> -> <new>`.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, or `-` / absent to read the patch from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`, `json`, or
  `auto` (the default, which detects the format).
- `--check` does everything but write: the same output and exit code, no file created, changed
  or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` with one `A` / `D` / `M` / `R` line per changed path plus `ok: <n> files`;
`1` with one `error: <code> <path>` line per failed edit plus `failed: <k> of <n> edits`;
`2` with exactly one line (`error: usage`, `error: no-patch`, `error: format`, or
`error: parse <N>`).

Node 22, standard library only. `runner.ts` is the kit's trial runner (kept as-is); `check.ts`
runs the practice set on your own machine:

```sh
node check.ts <practice.json>
```

## Verification

- Public practice set: **100 of 100 checks pass (practice score 1000)**.
- Hand-written checks derived sentence-by-sentence from the specification (kinds the practice
  set does not cover — second `---`/`+++` pairs, chained moves, tier-before-nearest matching,
  cursor and end-of-file V4A chunks, empty-file and no-newline corners, unicode path ordering,
  and more): **155 of 155 pass**.
- Random fuzz: **400 random patches over random trees — no crashes, deterministic output**.

This is variant A of the entry: a literal, conservative implementation of the specification —
fuzzy matching only where the specification orders it, correctness over aggressiveness.
