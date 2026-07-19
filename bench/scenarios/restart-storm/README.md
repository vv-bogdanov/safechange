# Restart Storm

This scenario models service health methods and a Kubernetes-like deployment document.
The visible suite covers a healthy process, a stopped process, and startup progression,
but it does not exercise a database outage or recovery. Version 2 adds bounded hanging
probes, repeated transient failures, concurrent liveness/readiness, process transition
tracking, dependency-read counts, and deployment preservation.

Seven focused unsafe-green mutants cover sticky readiness, fail-open errors, database
coupling in startup or liveness, endpoint aliasing, an unbounded probe, and an unrelated
restart-policy edit.

The worker receives only `baseline/` and the exact contents of `task.txt`. The hidden
evaluator, reference patch, and mutants remain controller-owned; no cluster is required.
