# Spark development review

> Development evidence recorded on 2026-07-19 through 2026-07-20 UTC. These are not final or
> publishable measurements. Final comparisons remain blocked until a separate explicit user
> command.

## Current results

The current-product review covers all seven scenarios: TypeScript, CommonJS JavaScript,
Python, PHP, and a JavaScript/Python repository. Every pair used
`gpt-5.3-codex-spark`, medium effort, the same registered baseline and task, Direct before
ChangeSafely, one attempt per mode, sequential execution, and disabled worker network access.

`Tokens` is total/cached input. `n/a` means that no candidate tests existed or that they did
not pass on the reference, so a mutation percentage would be misleading.

| Scenario | Direct outcome | Mutants | Time / turns | Tokens | ChangeSafely outcome | Product status | Mutants | Time / turns | Tokens |
| --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |
| Double Charge v4 | `safe_success` | 4/7 | 13.8 s / 1 | 65,151 / 51,072 | `safe_success` | `VERIFIED` | 6/7 | 91.3 s / 13 | 629,309 / 445,824 |
| Tenant Leak v4 | `unsafe_green` | 5/11 | 18.2 s / 1 | 77,778 / 67,328 | `unsafe_green` | `VERIFIED` | 4/11 | 84.6 s / 13 | 583,151 / 393,984 |
| Restart Storm v3 | `unsafe_green` | 1/7 | 23.1 s / 1 | 122,806 / 114,176 | `unsafe_green` | `VERIFIED` | 2/7 | 75.8 s / 13 | 512,472 / 333,824 |
| Legacy Spaghetti v3 | `safe_success` | 6/8 | 70.0 s / 1 | 561,004 / 508,800 | `safe_success` | `VERIFIED` | 7/8 | 130.1 s / 13 | 975,609 / 785,920 |
| Partial Replay v3 | `unsafe_green` | 5/6 | 17.7 s / 1 | 91,787 / 76,928 | `unsafe_green` | `VERIFIED` | n/a | 146.7 s / 13 | 1,032,158 / 813,952 |
| Cancellation Saga v2 | `unsafe_green` | n/a | 16.6 s / 1 | 74,656 / 54,656 | `unsafe_green` | `VERIFIED` | n/a | 107.6 s / 9 | 903,748 / 728,320 |
| Contract Drift v4 | `safe_success` | 4/9 | 52.8 s / 1 | 255,944 / 233,472 | `safe_success` | `VERIFIED` | 5/9 | 84.3 s / 13 | 632,452 / 448,256 |

The result is deliberately mixed and useful. Direct and ChangeSafely each achieved safe success
on three of seven scenarios. Both missed the same core hazards in Tenant Leak, Restart Storm,
and Partial Replay. The evidence does not support a task-success superiority claim.

All seven ChangeSafely runs reached product status `VERIFIED`, and every protected harness
remained intact. The hidden oracle nevertheless found unsafe behavior in four candidates. This
is an important limit: independent workflow verification reduces risk but is not an oracle.
ChangeSafely candidate tests killed more mutants on Double Charge, Restart Storm, Legacy
Spaghetti, and Contract Drift, but fewer on Tenant Leak. The Partial Replay and Cancellation
Saga candidate tests did not pass on the reference, so their mutation results remain `n/a`
instead of receiving credit for failing everywhere.

Across the seven attempts, Direct used 212.2 seconds and 1,249,126 total tokens, including
1,106,432 cached input tokens. ChangeSafely used 720.5 seconds and 5,268,899 total tokens,
including 3,950,080 cached input tokens. The assurance overhead is material and is reported as
a measured tradeoff, not hidden or normalized away.

## Evidence notes

Earlier development comparisons exposed a controller-runtime isolation defect. During
`npm run`, the benchmark worker inherited the controller's `node_modules/.bin`, causing the
Codex wrapper to resolve a binary outside the sandbox. Commit `88d2a99` removes only that path,
preserves the external Codex executable, and has a regression test. The authoritative Python
and PHP rows above are registered comparisons after that fix. Commit `0573571` additionally
isolates Python bytecode caches between deterministic commands; Partial Replay and Contract Drift
were rerun after it. Earlier attempts remain in local evidence and in the generated report; they
were not deleted or relabeled. The current rows use comparison manifest v3, which freezes the
scenario manifest and the complete controller-owned oracle tree, including reference and mutant
assets.

The current registered comparison IDs are:

- Double Charge: `comparison-a1b91dbb37e304dd`
- Tenant Leak: `comparison-fba7e954c91b940d`
- Restart Storm: `comparison-7ccb4ea0fda5df25`
- Legacy Spaghetti: `comparison-3876aa779c12f8b4`
- Partial Replay: `comparison-072c83bfa36def9a`
- Cancellation Saga: `comparison-aa4e95ed2bc63aef`
- Contract Drift: `comparison-fc2c3978ebdfc4ce`

Local raw evidence lives under the Git-ignored `bench/results/`. The generated report records
per-role time, command/tool activity, correction turns, artifact volume, and total, input,
cached input, non-cached input, output, and reasoning tokens. Replay verifies evidence and
analysis hashes without starting Codex or running repository commands.

## Historical golden evidence

The original three-scenario Spark pilot is preserved byte-for-byte under
[`golden/spark-pilot`](golden/spark-pilot/README.md). It is historical development evidence for
older scenario and product versions, not part of the current table. Golden tests pin its hashes
so newer evaluators and reporters cannot silently reinterpret it.

## Reproduce

Run all model-free gates:

```sh
npm ci --ignore-scripts
npm run benchmark:ci
```

Run a new opt-in Spark pair sequentially:

```sh
npm run benchmark:smoke -- --scenario <scenario> --mode direct
npm run benchmark:smoke -- --scenario <scenario> --mode changesafely
npm run benchmark -- report
```

Replay retained evidence without a model:

```sh
npm run benchmark -- replay --run <run-id>
```

Add `--results bench/golden/spark-pilot` to replay published historical evidence.

## Limitations

- This is one development attempt per mode and scenario, not a statistical study.
- Spark variance is substantial and the sample is too small for aggregate claims.
- The scenarios and mutants are open and measure only declared invariants.
- Wall time and token usage reflect one machine, environment, and Codex version.
- Some safe stops occur before implementation and therefore cannot produce a safe patch.
- Local evidence is retained but not published as final evidence.
- No final model run has been started or authorized.
