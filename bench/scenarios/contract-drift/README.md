# Contract Drift

This polyglot scenario evolves a versioned JSON event shared by a JavaScript producer and a
Python consumer. Correctness requires coordinated changes in both working directories while
preserving old messages, exact integer strings, unknown-field tolerance, empty optional values,
and replay ordering. Scenario version 2 made the public wire shape explicit after a development
smoke correctly stopped for a human decision on the previously ambiguous discount contract.
Scenario version 3 records each mutant's complete hidden-failure contract without changing its
behavior.

The repository exposes two explicit, deterministic checks and two test roots through one tracked
ChangeSafely capability contract. No network service or dependency installation is involved.
The hidden cross-language evaluator, reference patch, and unsafe mutants remain controller-owned.
