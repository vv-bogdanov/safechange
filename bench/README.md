# ChangeSafely Risk Suite

Specification and task cards for the ChangeSafely pilot benchmark.

## Reading order

1. [`BENCHMARK_SPEC.md`](BENCHMARK_SPEC.md) - primary specification: motivation,
   registered methodology, isolation contract, scenarios, and completion criteria.
2. [`BENCHMARK_TASKS.md`](BENCHMARK_TASKS.md) - public task text and controller-only
   scenario notes for the three benchmark tasks.

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
