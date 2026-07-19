# ChangeSafely Risk Suite

Specification and task cards for the ChangeSafely pilot benchmark.

## Reading order

1. [`BENCHMARK_SPEC.md`](BENCHMARK_SPEC.md) - primary specification: motivation,
   registered methodology, isolation contract, scenarios, and completion criteria.
2. [`BENCHMARK_TASKS.md`](BENCHMARK_TASKS.md) - public task text and controller-only
   scenario notes for the three benchmark tasks.
3. [`RESULTS.md`](RESULTS.md) - retained Spark development-pilot results and their
   limitations. These are not final measurements.
4. [`golden/spark-pilot`](golden/spark-pilot/README.md) - published, hash-verified
   evidence for the two current-product Spark pairs.

## Core idea

The benchmarks must test ChangeSafely's unique promise, not a model's general ability to write code:

> A small change with a large potential blast radius should result not merely in green existing tests, but in an evidence-backed branch verified against hidden invariants, scope, and known unsafe implementations.

The MVP compares two modes:

- **Codex Direct**
- **ChangeSafely**

across three open TypeScript scenarios:

- Double Charge;
- Tenant Leak;
- Restart Storm.

This is an open pilot evaluation, not a universal industry benchmark.

## Execution policy

- deterministic validation and replay never call a model;
- live development comparisons use Spark;
- final measured or publishable runs require a separate explicit user command after
  the Spark results have been evaluated;
- the worker receives only the selected baseline and verbatim public task, never this
  controller directory or the hidden oracle.

## Development commands

Validate the fixture and prove the Linux permission boundary without a model call:

```sh
npm run benchmark:validate
npm run benchmark -- canary --scenario double-charge
```

`npm run benchmark:ci` also exercises evidence hashing, corruption rejection,
candidate-test mutation analysis, replay, and report generation with no model call.

Run the opt-in Spark comparison sequentially. The controller rejects ChangeSafely
until the matching Direct attempt exists, and refuses a second attempt in either mode:

```sh
npm run benchmark:smoke -- --scenario double-charge --mode direct
npm run benchmark:smoke -- --scenario double-charge --mode changesafely
```

The smoke command defaults to `gpt-5.3-codex-spark`. `--model` remains available for
an explicit override, but the controller rejects non-Spark runs until a separate user
command authorizes final measurements.

After reviewing an evaluated paired Spark comparison for the same scenario, a final
measurement still requires both an explicit model and the `--final` gate:

```sh
npm run benchmark -- run --scenario <scenario> --mode direct --model <id> --final
npm run benchmark -- run --scenario <scenario> --mode changesafely --model <id> --final
```

Do not run these commands without separate user authorization. The measurement type
is persisted in every newly created comparison and run document.

Tenant Leak uses the same commands with `--scenario tenant-leak` after its deterministic
validator passes. Restart Storm uses `--scenario restart-storm` under the same gate.

Evaluate candidate-added tests against the reference and declared mutants, then replay
only the persisted hash-verified evidence and generate the paired report:

```sh
npm run benchmark -- evaluate --run <run-id>
npm run benchmark -- replay --run <run-id>
npm run benchmark -- report
```

`evaluate` runs deterministic test commands with tool network access disabled. `replay`
never starts Codex, test commands, or a network call. Reports are derived from verified
evidence and analysis documents and contain no aggregate safety score.

Attempts are stored under ignored `bench/results/` directories as immutable,
hash-verified evidence packages. A non-Spark model is intentionally rejected until
Spark results are evaluated and a separate user command authorizes final measurements.
