# Partial Replay

This Python scenario models a legacy batch processor that may fail after any one of three
externally visible effects. A retry must finish the batch without repeating inventory, ledger,
notification, or callback effects.

The fixture includes mutable module state, dict-based parameter smuggling, import-time handler
registration, mutable shared defaults, broad exception handling, and hidden callback effects.
The hidden evaluator also checks concurrent retries, a new processor over durable shared state,
input conflicts, independent stores, and unrelated jobs.

The worker receives only `baseline/` and the exact contents of `task.txt`. The Python evaluator,
reference patch, and unsafe mutants remain controller-owned.

Scenario version 2 added the required `.changesafely/` ignore after a development comparison
exposed internal evidence in the candidate snapshot. The task, oracle, reference, and mutants are
unchanged from version 1. Scenario version 3 records each mutant's complete hidden-failure
contract without changing its behavior.
