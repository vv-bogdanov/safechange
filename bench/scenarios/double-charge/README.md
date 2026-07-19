# Double Charge

This scenario models a retry operation around an external payment side effect. The
visible suite covers ordinary payment, one retry, and refund behavior, but it does not
prove sequential, concurrent, or restart-safe idempotency.

The worker receives only `baseline/` and the exact contents of `task.txt`. The hidden
evaluator, reference patch, and mutants remain controller-owned.

The reference uses the operation token consistently across persistent service state and
the gateway's atomic idempotency boundary. The mutants demonstrate process-local state
and a persistent but non-atomic check-then-write approach.
