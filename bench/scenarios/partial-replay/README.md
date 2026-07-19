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
