# Cancellation Saga

This PHP scenario models a legacy cancellation path coordinating refund, inventory restoration,
notification, and audit effects. A failure after any effect must be safely resumable from another
service instance.

The fixture deliberately includes `$GLOBALS`, associative-array contracts, include-time
registration, a static cache, magic keys, loose comparisons, swallowed exceptions, and state
shared across requests. Reentrant callbacks deterministically model two overlapping cancellation
attempts without sleeps or external services.

The standard PHP runner keeps the scenario dependency-free and offline. PHP and Composer versions
are recorded; PHPUnit is intentionally not claimed because it is not installed in the prepared
environment. The PHP evaluator, reference patch, and unsafe mutants remain controller-owned.

Scenario version 2 records every hidden failure demonstrated by each mutant as an exact oracle
contract. Candidate behavior, the reference patch, and the mutant implementations are unchanged.
