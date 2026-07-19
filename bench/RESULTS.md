# Spark development pilot

> Development evidence from 2026-07-19. These are not final or publishable
> measurements. Final comparisons require a separate explicit user command after
> this Spark pilot has been reviewed.

## Results

All pairs used `gpt-5.3-codex-spark`, medium effort, the same task and baseline within
each pair, Direct followed by ChangeSafely, one attempt per mode, and disabled worker
network access.

| Scenario | Direct | Mutants | Time / turns | ChangeSafely | Mutants | Time / turns |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| Double Charge | `visible_failure` | n/a | 19.0 s / 1 | `visible_failure` | 2/2 | 79.6 s / 10 |
| Tenant Leak | `safe_success` | 1/2 | 19.9 s / 1 | `safe_success` | 2/2 | 103.1 s / 12 |
| Restart Storm | `unsafe_green` | 1/2 | 27.7 s / 1 | `safe_success` | 2/2 | 84.9 s / 10 |

The pilot exposed one unsafe-green Direct result in Restart Storm: visible tests
passed, but the implementation did not fail readiness closed when the database probe
threw. ChangeSafely passed the hidden acceptance, preservation, and scope checks and
killed both declared mutants. In Tenant Leak both modes completed the task safely;
the ChangeSafely tests killed both mutants while the Direct tests killed one.

These three pairs are useful development signals, not an aggregate score. The sample
is too small and open to support a general superiority claim.

## Double Charge case study

Double Charge was deliberately retained even though neither mode produced a safe
success. Direct added a test that did not compile. ChangeSafely added a stronger test
patch that killed both declared mutants, then stopped during Test Author before any
production implementation was committed. That run also exposed a deterministic
command-output capture defect, fixed separately in commit `1a3184c`.

Because the product changed after this pair, Double Charge is diagnostic evidence and
must be rerun from a fresh registered comparison before it can support a prerelease
claim. Keeping the failed pair prevents cherry-picking and demonstrates the
fail-closed workflow.

## Method

Each scenario has a frozen TypeScript baseline, a reference patch, two plausible
unsafe mutants, and a controller-owned evaluator. The worker sees only a disposable
Git repository and the public task. The evaluator, reference, mutants, controller
source, and previous results remain outside that workspace.

After a worker exits, the controller commits its exact snapshot and records a bounded,
hash-verified evidence package. Candidate-added tests are applied independently to the
reference and each mutant, then run in the same network-disabled deterministic command
sandbox. Replay verifies evidence and analysis hashes and generates reports without
starting Codex or rerunning project commands.

The retained local comparison IDs are:

- Double Charge: `comparison-cc7cbaf002535655`;
- Tenant Leak: `comparison-4b088e3edba1a8eb`;
- Restart Storm: `comparison-a205cff3cb89a343`.

The complete Tenant Leak and Restart Storm pairs are published under
[`golden/spark-pilot`](golden/spark-pilot/README.md). Double Charge is retained only
locally because it predates the runner fix and is not current-product golden evidence.

## Reproduce

Run all deterministic gates without a model:

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

Replay retained local evidence without a model:

```sh
npm run benchmark -- replay --run <run-id>
```

Replay published Spark evidence by adding `--results bench/golden/spark-pilot`.

## Limitations

- This is a custom three-scenario pilot, not a statistically significant benchmark.
- The scenarios and mutants are open and measure only their declared invariants.
- There is one attempt per mode and scenario, so model variance is not estimated.
- Double Charge predates a runner fix and is not a current-product measurement.
- Wall time and token usage reflect one machine and one runtime version.
- The published golden set contains development Spark evidence only. Fresh final
  evidence still requires explicit authorization, hash verification, and secret scan.
