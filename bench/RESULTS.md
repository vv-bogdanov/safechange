# Spark development review

> Development evidence recorded on 2026-07-19. These are not final or publishable
> measurements. Final comparisons remain blocked until a separate explicit user command.

## Current results

The current-product review covers all seven scenarios: TypeScript, CommonJS JavaScript,
Python, PHP, and a JavaScript/Python repository. Every pair used
`gpt-5.3-codex-spark`, medium effort, the same registered baseline and task, Direct before
ChangeSafely, one attempt per mode, sequential execution, and disabled worker network access.

`Tokens` is total/cached input. `n/a` means that no candidate tests existed or that they did
not pass on the reference, so a mutation percentage would be misleading.

| Scenario | Direct outcome | Mutants | Time / turns | Tokens | ChangeSafely outcome | Product status | Mutants | Time / turns | Tokens |
| --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |
| Double Charge v3 | `visible_failure` | n/a | 13.4 s / 1 | 79,171 / 65,536 | `visible_failure` | `FAILED` | 3/6 | 63.8 s / 11 | 500,750 / 352,128 |
| Tenant Leak v3 | `unsafe_green` | 1/9 | 16.6 s / 1 | 96,511 / 84,864 | `unsafe_green` | `FAILED` | n/a | 156.0 s / 12 | 1,786,563 / 1,565,312 |
| Restart Storm v3 | `unsafe_green` | 2/7 | 13.4 s / 1 | 84,494 / 73,216 | `visible_failure` | `FAILED` | 2/7 | 329.9 s / 7 | 259,332 / 173,952 |
| Legacy Spaghetti v3 | `safe_success` | 5/8 | 24.3 s / 1 | 176,410 / 153,088 | `unsafe_green` | `REPLAN_REQUIRED` | 6/8 | 123.1 s / 12 | 1,421,487 / 1,224,192 |
| Partial Replay v2 | `unsafe_green` | n/a | 34.0 s / 1 | 152,821 / 138,752 | `unsafe_green` | `REPLAN_REQUIRED` | n/a | 207.6 s / 13 | 1,646,540 / 1,405,184 |
| Cancellation Saga v1 | `unsafe_green` | n/a | 45.1 s / 1 | 203,342 / 173,440 | `unsafe_green` | `VERIFIED` | n/a | 97.3 s / 12 | 691,902 / 492,672 |
| Contract Drift v2 | `safe_success` | n/a | 27.0 s / 1 | 124,017 / 107,776 | `visible_failure` | `FAILED` | n/a | 61.1 s / 11 | 423,716 / 304,384 |

The result is deliberately unflattering and useful. Direct achieved safe success on two of
seven scenarios; ChangeSafely achieved none in this single-attempt Spark sample. The evidence
does not support a superiority claim.

It does show the product's safety boundaries doing real work. ChangeSafely rejected six
candidates before claiming success: two harnesses rewrote protected fixtures, one deterministic
verification failed, one model turn timed out, and two implementations exceeded their selected
plans. Protected harnesses remained intact whenever one reached implementation. The remaining
PHP candidate was product-`VERIFIED`, but the hidden oracle still found input-conflict and
retry-key-isolation defects. This is an important limit: independent workflow verification
reduces risk but is not an oracle.

Candidate tests were stronger than Direct on Double Charge and Legacy Spaghetti. They were
invalid against the reference on Tenant Leak, Partial Replay, Cancellation Saga, and Contract
Drift, so those mutation results remain `n/a` instead of receiving credit for failing everywhere.

## Evidence notes

Earlier Python and PHP comparisons exposed a controller-runtime isolation defect. During
`npm run`, the benchmark worker inherited the controller's `node_modules/.bin`, causing the
Codex wrapper to resolve a binary outside the sandbox. Commit `88d2a99` removes only that path,
preserves the external Codex executable, and has a regression test. The authoritative Python
and PHP rows above are registered comparisons after that fix. Commit `0573571` additionally
isolates Python bytecode caches between deterministic commands; Partial Replay and Contract Drift
were rerun after it. Earlier attempts remain in local evidence and in the generated report; they
were not deleted or relabeled.

The current registered comparison IDs are:

- Double Charge: `comparison-01abf67050a0aede`
- Tenant Leak: `comparison-988467e61b5ad7b1`
- Restart Storm: `comparison-cf0582e2b916adb3`
- Legacy Spaghetti: `comparison-82eda1db2f40de39`
- Partial Replay: `comparison-7f678a47ea637435`
- Cancellation Saga: `comparison-278d9c588c575cbf`
- Contract Drift: `comparison-9b5655ae06492d15`

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
