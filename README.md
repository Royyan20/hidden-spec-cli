# hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Royyan20/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Royyan20/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every AI edit format: it reads a patch in unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits, finds the lines each edit names even when the model drifted their whitespace or indentation, and writes every change or none. Practice checks: 100/100, score 1000.

## Run it

```sh
node main.ts [options] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=91kr9e6a&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`. It implements SPEC.md in full: unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits, and line matching at three tiers, with an all-or-nothing write. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit code, everything written to stdout and every file afterwards are exactly what SPEC.md says. stderr is never compared. Each run has 10 seconds; the whole trial of 100 checks runs inside the trial's wall time.
