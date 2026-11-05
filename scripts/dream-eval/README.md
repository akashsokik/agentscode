# Offline dreaming eval

Does an agent apply lessons from one session in the next, and how much of that is dreaming's doing?
This script replays fixed scenarios against the real engine. Each scenario runs in four arms, and
plain code scores session 2 (no LLM judge). It is the controlled half of "is dreaming helping"; the
in-app dream stats are the live half.

It runs on demand. It is not part of `npm test` and does not start the AgentsCode server.

```
node scripts/dream-eval/run.ts --dry                                  # free: fake engine, checks plumbing and arms
node scripts/dream-eval/run.ts --scenarios hard --max-cost 20         # real engine: spends tokens
node scripts/dream-eval/run.ts --scenarios hard --samples 3 --max-cost 50
node scripts/dream-eval/run.ts --list
```

| option | meaning |
| --- | --- |
| `--scenarios a,b` | scenario ids, or a group: `hard`, `explicit`, `all` (default `all`) |
| `--arms a,b` | any of `off`, `none`, `dream-only`, `on` (default: all four) |
| `--samples N` | runs of each scenario and arm (default 1) |
| `--max-cost USD` | stop at the first check where spend is past this (default 5); see Budget |
| `--seed N` | seed for the run order (default random, printed) |
| `--engine claude\|codex`, `--model <id>` | the agent's engine and model |
| `--turn-timeout <s>` | give up on a turn after this long (default 900) |
| `--dry` | scripted engine and dream model: free |
| `--claude-auto-memory` | leave Claude Code's own memory on (see Isolation) |

## The arms

Every scenario follows the same flow:
1. **Session 1:** three or more user messages that contain the lesson(s).
2. **New session:** a session end, which fires the real session-end dream when dreaming is on.
3. **Reset:** the project goes back to its seed.
4. **Session 2:** a different task where the lesson matters.

The arms differ only in dreaming and in what memory holds at session 2:

| arm | dreaming | memory at session 2 | what it tells you |
| --- | --- | --- | --- |
| off | off | whatever the agent saved itself with `remember` | today's product |
| none | off | emptied | can the task be done without memory? If so, the scenario is "too easy" |
| dream-only | on | the agent's own entries removed before the dream (and again before session 2) | what the dream captures on its own |
| on | on | everything | the product with dreaming |

- **What dreaming adds:** `on − off`, the headline number.
- **Capture:** `dream-only` against `off` compares the dream's capture with the agent's own.
- **Attribution:** every memory entry is attributed to its writer, with A for the agent's `remember` and D for a dream. The "memory" column and the JSON show who held each lesson when session 2 started.
  - `dreamId` names an entry's last writer, not its first: a dream that updates the agent's entry keeps the id and stamps its own `dreamId` on it.
  - So the eval takes a snapshot of entry ids just before the dream. Entries that existed then stay the agent's, shown as `A*` (`rewritten: true`) when a dream changed them.
  - Only entries that are new since the snapshot and carry a `dreamId` count as the dream's.

### The real gate
- **No manual dream:** the eval never calls "Dream now". Session 1 has at least 3 turns, so `newSession()` runs the real session-end dream through the real gate (3 or more turns since the last dream).
- **Skipped dreams:** if the gate skips a dream, the run says so ("gate skipped").
- **Idle dreams:** these are off (`idleProcessMs` is set to a day), so the session-end dream is the only one.

## Scenarios

| id | kind | lesson | scored on |
| --- | --- | --- | --- |
| implicit-fix | hard | the user strips the semicolons from the agent's file by hand and says only "I tidied it" | no semicolons in the new src/case.js |
| silent-failure | hard | the build fails with a vague error until `BUILD_TARGET=node` is set; the agent finds this itself, and the user only says "Great, that works." | the first build in session 2 already sets the variable |
| multi-lesson | hard | three conventions in one 4-turn session: kebab-case file names, `log()` from src/util/logger.js instead of console, and a JSDoc on every export | all three on the new file (the detail gives k/3) |
| passing-preference | hard | "by the way, I like error messages to start with the module name in brackets", said once inside another request | every error message in src/duration.js starts with `[duration]` |
| tabs-indent | explicit | indent with tabs | the new src/math.js (N/A if nothing is indented) |
| test-command | explicit | `npm test` is stale; run `node --test` (a lesson from a failure) | the commands run |
| changelog | explicit | every change gets a line under `## Unreleased` in CHANGELOG.md (the seed has none) | CHANGELOG.md |
| spdx-header | explicit | new files start with `// SPDX-License-Identifier: Apache-2.0` | the new files' first lines |
| spec-dir | explicit | tests go in `spec/<name>.spec.js` | where the new tests are |
| files-changed | explicit | end replies with a "Files changed:" list | the final reply (inline or a list) |
| app-error | explicit | throw `AppError` from src/errors.js | the new src/port.js |
| generated-config | explicit | settings.json is generated: edit settings.src.json and run gen-config.js | the config files, and that the generator was run (not just read) |

- **Explicit scenarios** are plain corrections. Real agents save these themselves: in the first real run they did so 8 times out of 8, so off and on both scored 100% and dreaming had no room to help.
- **Hard scenarios** are lessons agents rarely save themselves.
- **Seed contents:**
  - No seed file states a lesson.
  - Where a lesson needs a file to exist (src/errors.js, gen-config.js, the logger), the "none" arm measures whether that file alone gives it away.

### Scoring
- **Deterministic:** scorers read the files, the commands and the final reply.
- **Commands:** they are split into simple invocations (on newlines, `;`, `&&`, `||` and `|`). So `grep jest package.json` does not count as running jest, and `cat scripts/gen-config.js` does not count as running the generator.
- **Report lines:** they print the matching line or invocation.
- **Inconclusive runs:** "N/A" (`pass: null`) means there was nothing to judge, for example no indented lines. These runs are left out of the rates.

## Output
- **Table:** a verdict per scenario per arm. With `--samples`, cells show passes over scored runs, for example `2/3 (+1)`, where the bracketed number counts runs that weren't scored.
- **Memory column:** A, D or - per lesson, per arm.
- **Dreams column:** the dream status and ops applied over total, for the dream-only and on arms.
- **Summary lines:**
  - the lesson-follow rate per arm: overall, hard and explicit
  - what dreaming adds (on − off)
  - lessons in memory by writer
  - which scenarios were too easy
  - dreams run and skipped by the gate, ops applied and rejected (with reasons), and dream cost
  - session cost per arm, total cost and time
- **Misses:** every miss with dreaming, every inconclusive run and every error, each with the stage it reached and the dream's diary or rejection reasons.

### Files
- **`/tmp/dream-eval/<ts>.json`:** the summary and all results. It is rewritten after every arm, so a stopped run still leaves results.
- **`/tmp/dream-eval/<ts>.jsonl`:** one line per arm as it finishes.
- **`/tmp/dream-eval/<ts>/<scenario>-<arm>-s<n>/`:** links to that run's `project` and `data`. The data dir holds the transcript, `agents/<id>/memory.md`, `dreams.jsonl` and `dreams.md`.

### Statuses
- **ERROR:** the run broke, for example a timeout or an engine error. The error records the stage: `session 1, turn 2/3`, `session end and dream`, `session 2` or `scoring`.
- **STOP:** the cost cap was reached.

Neither counts as a miss.

## Budget, order and signals
- **`--max-cost`:**
  - Spend is checked after every turn and after each dream. A run stops at the first check past the cap, so it can overshoot by about one turn.
  - When the cap stops a run, no further runs start, and the JSON lists what finished.
- **Rough costs:** about $0.20 per real turn.
  - An explicit arm is about 4 turns, roughly $0.80.
  - A hard arm is 4 or 5 turns, roughly $1.
  - A dream is about $0.02.
  - All 12 scenarios × 4 arms is about $40.
  - The 4 hard ones × 4 arms is about $15.
  - One sample per cell is noisy, so use `--samples 3` before trusting a difference of one scenario.
- **Order:**
  - (scenario, sample) blocks run in random order, and arms run in random order within each block, from `--seed`.
  - That way, drift over the run (rate limits, model load) doesn't always land on the same arm.
- **Signals:** on SIGTERM or SIGINT the script:
  1. shuts down the running agent's manager, which closes the engine processes
  2. saves the JSON
  3. exits with 143 or 130

## Dry mode

`--dry` swaps in a scripted engine (`fake.ts`) and a scripted dream model. Everything else runs for real:
- the AgentManager
- session instructions with memory
- the comms endpoint and `remember`
- the session-end trigger and the gate
- the digest
- the server's evidence checks and apply step
- `forgetMemory`
- the scorers

The fake agent:
- knows a lesson only when the lesson is in its context (its instructions or the prompt)
- saves a lesson with `remember` only in explicit scenarios, as real agents do

The fake dream acts as an ideal dream within the rules:
- For each lesson that memory doesn't already hold, it cites the digest item carrying that lesson, a trusted one if there is one.
- The server still checks that citation.

So a working pipeline gives:

| | off | none | dream-only | on |
| --- | --- | --- | --- | --- |
| explicit | PASS (A) | FAIL | PASS (D) | PASS (A; the dream sees it in memory and does nothing) |
| hard | FAIL | FAIL | PASS (D) | PASS (D) |

The script also checks that:
- the session-end dream ran in every dreaming arm, and in no other
- no extra dreams ran
- each lesson's writer matches the table above

It prints "Plumbing check: OK" or lists every mismatch, and exits 1 on any mismatch.

To test the cap for free, set `DREAM_EVAL_DRY_DREAM_USD=1` so each dry dream reports a cost.

## Isolation
- **Folders:**
  - The project is at `<os tmp>/ws-XXXXXX/<package name>`.
  - The data dir is a separate `<os tmp>/st-XXXXXX`, so the data dir is not next to the project.
  - The agent sees its project path, and the dream runs in the agent's home, so neither path names the scenario or the eval.
  - `AGENTSCODE_HOME` points into the run folder; `~/.agentscode` is never touched.
- **Comms:**
  - The agents' comms tools call back on `PORT`.
  - This script answers only `POST /api/comms`, on a random port on 127.0.0.1, so it never reaches an AgentsCode app you have open.
  - It is not the AgentsCode server: there is no UI, no REST API and no websocket.
- **Claude Code's own auto memory:**
  - It is off by default (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). Otherwise it would carry lessons in every arm and write entries into `~/.claude/projects`.
  - Use `--claude-auto-memory` to include it. Codex has no equivalent.
- **Permissions:**
  - Agents run with autonomy `full`, so no turn waits for approval.
  - Questions are answered with "choose yourself", and plans and tools are allowed.
  - Only run real mode where that's acceptable.

## Adding a scenario
1. Add `scenarios/<id>.ts` exporting a `Scenario` (see `scenario.ts`). It needs:
   - `kind`
   - `lessons`, each with:
     - `text`
     - a `knows` regex that matches its own text
     - an `evidence` substring that names the session-1 item a dream would cite
   - `seed`
   - `session1`, at least 3 messages
   - `userEdits`, optional
   - `session2`
   - a deterministic `score`
   - `fake`
   - `fakeRemembers`
2. Add the scenario to `scenarios/index.ts`.
3. Run `--dry`. It has to pass the dry-run expectations above.

## Files
- `run.ts`: CLI, plan, budget, signals, report, JSON
- `harness.ts`: one scenario in one arm against a real AgentManager
- `dream.ts`: the only contact with the dreaming code in `server/`:
  - the `dreaming` toggle
  - `forgetMemory`
  - the dream-model injection for dry runs
  - `dreams.jsonl`
  - writer attribution
- `fake.ts`: the dry engine and dry dream model
- `comms.ts`: the comms-only endpoint
- `view.ts`: what scorers see
- `scenario.ts`: the types
- `scenarios/`: the scenarios and the scorer helpers (`util.ts`)
