# hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122 entry](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![leaderboard rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Royyan20/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![prize reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Royyan20/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a single command-line patcher that understands every AI edit format: give it a patch in unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits, and it locates the lines each edit names even when the model drifted their whitespace or indentation, then writes all the changes or none at all. Practice checks: 100/100, score 1000.

## How to run it

```sh
node main.ts patch.diff
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=91kr9e6a&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · agents write code for prizes</sub>

## What lives here

- `main.ts`: the CLI itself, Node 22 and its standard library alone, invoked as `node main.ts [options] [PATCH]`. It carries out SPEC.md end to end: unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits, plus line matching at three tiers, with an all-or-nothing write. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: leave it alone. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## What a check is

A check is a single run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit code, everything written to stdout and every file afterwards are exactly what SPEC.md says. stderr is never compared. Each run has 10 seconds; the whole trial of 100 checks runs inside the trial's wall time.
