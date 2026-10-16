# measure-profiles

Reproducible token measurement of orq's cost profiles (`max`, `balanced`, `saver`).

```sh
bun scripts/measure-profiles.ts --dry-run                       # no claude: fixture, team and launch commands
bun scripts/measure-profiles.ts                                 # 1 run of max + 1 of saver
bun scripts/measure-profiles.ts --n 3 --profiles max,saver --timeout 20m
```

> **Every real run spends the user's Claude quota** (about 1.5–1.8 M raw tokens per run with the
> default task). Run it only when it was agreed. Use `--dry-run` to check the setup.

## What it does

For each profile and repetition:

1. Creates a temp work dir (`$TMPDIR/orq-measure-*`). Inside it goes a temp `ORQ_HOME`, seeded
   from `defaults/` (read only), and a copy of a small Bun/TS git repo: `src/math.ts`, `src/str.ts`,
   `src/index.ts` and `test/math.test.ts`.
2. Starts HQ directly, with no TUI and `ORQ_SAFE=1`. The team is `cto` (lead) + `backend` + `qa` +
   `reviewer`, with permission `auto` and the profile under test.
3. Accepts the fixture's folder-trust dialog. No other notice is answered.
4. Sends the scripted task to the lead as the user: add `slugify` with tests, reviewed by
   `reviewer` and validated by `qa`. `--task` replaces it.
5. Waits for the lead's report to the user, or for `--timeout` (default `20m`).
6. Stops the run. `hq.stop()` kills only that run's tmux sessions: its own runId, guarded by
   `ORQ_SAFE`.
7. Measures the run:
   - `runTokenUsage` for raw tokens.
   - `runTokenCost` for the weighted cost: input 1×, cache write 1.25× (2× for the 1 h TTL),
     cache read 0.1×, output 5×. If `src/tokens.ts` has no `runTokenCost`, it uses its own
     weighting with the same weights.
   - Requests per agent.
   - `bun test` in the fixture.
   - Whether there was a review (a report from `reviewer`) and a QA pass (a report from `qa`).
   - Messages left without a `delivered` event.

At the end it prints a markdown report:

- A table per agent and a total, with the mean tokens, cost and requests of each profile and the
  Δ % against the first profile in `--profiles`.
- A table per run: finished or timeout, minutes, messages, undelivered messages, review, QA and
  `bun test`.
- The list of stuck messages, if any.

Then it removes the work dir (fixtures and `ORQ_HOME`) and `~/.claude/projects/<fixture>`. Use
`--keep` to inspect them. Ctrl+C stops the current run and cleans up.

## Options

| Option | Default | |
|---|---|---|
| `--n <k>` | `1` | Runs per profile. Use 3 or more: LLM variance is large (one run may add an extra review round). |
| `--profiles a,b` | `max,saver` | The first one is the baseline of the Δ columns. |
| `--timeout <d>` | `20m` | Per run (`90s`, `20m`, `1h`). |
| `--task "<text>"` | slugify task | The same text is used for every run. |
| `--budget <t>` | `4M` | Raw-token cap for the whole measurement (`4M`, `3500k`), checked every 5 s. When it is crossed, the current run is stopped and measured, the remaining runs are skipped and the report says so. |
| `--dry-run` | | Builds the fixtures and the launch files, and prints the `claude` commands of every agent. It does not start HQ, tmux or claude. |
| `--keep` | | Leaves the work dir and the transcripts. |

## Reading the result

- The cost column matters more than raw tokens. Most of the raw tokens are cache reads of the same
  ~47 k-token prefix on every request, and those are billed at 0.1×.
- Compare runs with the same amount of work (messages and requests per agent). A difference driven
  by an extra review round is LLM variance, not the profile.
- In `saver`, readers other than the lead start dormant: they are launched on their first message.
