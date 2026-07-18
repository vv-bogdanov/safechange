# SafeChange MVP implementation plan

> **Status:** completed on 2026-07-18. This file is the implementation record for
> the MVP checkpoints. See [`README.md`](./README.md) for current usage and
> [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the active development workflow.

## 1. Goal and current state

When this plan was written, the repository contained only the product specification and architecture documents. There was no package, source code, test suite, or initial Git commit yet.

The MVP goal is one reproducible vertical workflow for a prepared TypeScript/Node.js payment-retry repository:

```text
preflight
-> scratch discovery (D0)
-> canonical contract (C0)
-> independent plans
-> deterministic eligibility gates
-> explainable selection
-> protected safety harness (T1)
-> one implementation (I1)
-> deterministic checks
-> independent verification
-> report and branch, or an explicit safe stop
```

Implementation proceeded in the stages below. Each stage ended with a runnable, testable product increment. The first increment was read-only planning; write phases were added only after it worked against a real repository.

## 2. MVP boundary

### Included

- A strict TypeScript CLI for local Git repositories.
- Codex App Server over local JSONL/`stdio` as the only AI runtime.
- Separate D0 and C0 root threads.
- From 1 to 5 planner forks from C0, with 3 standard lenses by default.
- Schema-constrained model output plus local schema validation.
- Deterministic plan gates before the Judge.
- One SafeChange branch, one safety-harness commit, and one implementation commit.
- Deterministic command, Git diff, scope, manifest, and protected-file checks.
- An independent Verifier forked from C0.
- One bounded repair attempt for an in-scope implementation defect.
- Persistent JSON/Markdown run artifacts and minimal resume support.
- One controlled npm-based TypeScript payment/retry demo.

### Excluded

- Web UI, GitHub App, MCP, Codex Skill, CI/CD platform, deployment, external writes, destructive migrations, worktree management, multiple implementations, and support for every language or package manager.
- Automatic `stash`, cleanup, rollback, or history rewriting.
- A generic workflow engine, event bus, database, policy language, or App Server SDK.

### Development posture: prove the path first

The final product must satisfy the safety guarantees in this plan, but not every guarantee must block the first development run. Development should use a controlled demo repository with no production credentials or external effects, get the vertical path working, and tighten the boundary before calling the result MVP-ready.

The following constraints would be excessive during the first implementation passes and are deferred to hardening or pre-release:

- A hard-coded numeric Codex version. During development, use the standard `codex` from `PATH`, record its version, and regenerate protocol files as needed. Exact runtime/generated-version equality becomes a release gate.
- Cross-platform sandbox support from the start. Early development commands may run only against the trusted, dependency-light demo with fixed argv. A run using this shortcut must be labelled development-only and cannot end in the product status `VERIFIED`; network-disabled sandbox enforcement is required before release.
- Full interrupted-run recovery. Until the happy path works, a failed development run may be restarted from B0. Artifact persistence stays, but `resume` correctness is a hardening task.
- Complete provenance metadata and atomic recovery for every intermediate file. Start with schema-valid evidence, contract, plans, decision, and verification output; add exhaustive hashes, input lineage, atomic writes, and recovery checks after the workflow closes end to end.
- Exhaustive baseline fingerprints. Start with `HEAD`, tracked/index state, manifests, and instruction files. Add protected configuration fingerprints and broader invalidation coverage before release without exposing secret contents.
- Planner parallelism, prompt-cache optimization, latency budgets, and output trimming. Sequential independent forks are sufficient to prove lineage and plan diversity; parallelize only for demo speed after correctness.
- General command discovery and multi-package-manager support. The first runner may use the demo's fixed npm test/typecheck/build commands. General structured command approval comes during hardening.
- A complete negative-test matrix, polished error taxonomy, bounded-log formatting, install packaging, and two-run demo timing. Add these after the first real golden path succeeds.
- The Verifier repair loop. First prove a straight B0 -> T1 -> I1 -> verification run; add the single bounded repair only after the no-repair path is stable.
- A permanent ban on additional small dependencies during development. Standard library remains preferred, but a small proven module is acceptable when it materially shortens protocol, schema, or test work. Audit and remove unjustified dependencies before release.
- The proposed file layout and internal function boundaries. They are a starting point, not an API commitment; change them when the first implementation shows a simpler shape.

The following are product-defining and must hold from the first relevant vertical slice:

- D0 and C0 are separate root threads, and all roles fork from C0.
- Role outputs are locally schema-validated artifacts.
- Implementer does not inherit Planner history; Verifier does not inherit Implementer history.
- Read-only planning does not change tracked target state.
- Only one writer runs at a time and only one plan is implemented.
- The safety harness is created before production code and is not weakened by implementation.
- Real exit codes and Git state are recorded; no fallback may manufacture success.
- No production credentials, production writes, destructive Git cleanup, or silent scope expansion.

### Instructions for the coding agent: development commits

- This subsection governs development of the SafeChange repository by the coding agent. It is not functionality to implement inside the SafeChange CLI.
- Before writing application code, review the current Git status and create an explicit baseline commit containing only the agreed project documents. Do not mix bootstrap code into that baseline.
- After every completed development stage below, the coding agent must run its stage gate and create a separate commit containing only that stage's SafeChange changes. Do not wait until the end of MVP to create the first implementation commit and do not batch multiple stages into one commit.
- Within a larger stage, also commit a completed runnable vertical checkpoint before starting a risky rewrite. Prefer small revertable commits over a single cross-stage commit.
- Never include unrelated or pre-existing user changes. Do not use automatic `stash`, `reset`, `clean`, amend, or history rewriting.
- If a stage is not runnable or its relevant checks fail, do not mark it complete. Keep the work visible and fix it before making the stage checkpoint commit.

Suggested development checkpoints:

```text
B0  docs and explicit project baseline
D1  CLI bootstrap, schemas, and minimal App Server client
D2  read-only D0/C0/planner/Judge tournament
D3  golden demo and Test Author/T1 path
D4  Implementer/I1 and straight independent verification
D5  sandbox, recovery, negative gates, packaging, and demo hardening
```

These commits are mandatory checkpoints made by the coding agent while implementing SafeChange. They do not change runtime history in a target repository: D0, C0, planners, and Judge remain read-only there, and the SafeChange runtime creates only T1 and I1 after B0.

## 3. Concrete implementation choices

- **Runtime:** Node.js 20 or newer, ESM, strict TypeScript, npm.
- **CLI parsing:** `node:util.parseArgs`; no CLI framework.
- **Tests:** start with `node:test` and `node:assert`; change only if real test ergonomics justify it.
- **Schema validation:** start with `ajv`. JSON Schemas are the canonical role-output contracts and are also passed as `turn/start.outputSchema`.
- **Codex defaults:** invoke the standard `codex` executable from `PATH` and do not override the user's default model. Generate protocol TypeScript and JSON Schema from that build and store its exact `codex --version` value in `src/app-server/generated/protocol-version.json`. Development may regenerate on a version change; release preflight must fail on a mismatch. This preserves version-specific protocol types without hard-coding the currently installed version in this plan.
- **Transport:** one long-lived App Server child process per SafeChange run; JSONL on stdin/stdout; stderr captured separately.
- **Orchestration:** explicit async functions and a persisted phase enum, not a state-machine library.
- **Commands:** start with fixed structured argv and timeouts against the trusted demo. Before a run may report `VERIFIED`, require `shell: false`, a non-interactive sanitized environment, bounded output, and network disabled through the Codex sandbox wrapper. If the host cannot prove that setup works, stop with `BLOCKED` before repository scripts run.
- **Protected harness:** all files created or changed in T1 are immutable during I1 in the MVP. The Implementer may add separate test files, but may not edit T1 files. This is deliberately stricter and more reliable than attempting semantic assertion comparison.
- **Artifacts during planning:** `.safechange/runs/<run-id>/` is the only tool-owned write before the Git branch is created. Planning must not change tracked target files, the index, refs, or `HEAD`.

## 4. CLI contract

Initial commands:

```text
safechange plan --task <text> [--plans 1..5] [--repo <path>]
safechange run  --task <text> [--plans 1..5] [--repo <path>]
safechange resume --run <run-id> [--repo <path>]
```

- `--repo` defaults to the current directory; `--plans` defaults to `3`.
- Task input is non-interactive and required for a new run.
- `plan` stops after selection and never creates a branch.
- `run` executes the complete workflow.
- `resume` continues only from a validated phase boundary. It must refuse when artifact hashes, contract version, baseline fingerprint, or expected Git state do not match.
- Exit code `0` means a completed plan or `VERIFIED` run. Exit code `2` means an intentional safe stop (`BLOCKED`, `BASELINE_CHANGED`, `REPLAN_REQUIRED`, or `HUMAN_DECISION_REQUIRED`). Exit code `1` means an unexpected/internal `FAILED` run.
- The terminal prints the run id, current phase, selected plan, final status, report path, branch/commit ids when present, reason, and next action. Detailed logs stay in artifacts.

## 5. Minimal source layout

```text
package.json
tsconfig.json
src/
  cli.ts                         # argument parsing and exit codes
  workflow.ts                    # ordered phases and transitions
  prompts.ts                     # role-specific prompt builders
  schemas.ts                     # artifact JSON Schemas and TS types
  artifacts.ts                   # validation, hashing, atomic persistence
  eligibility.ts                 # pure deterministic plan gates
  git.ts                         # safe read/check/branch/diff/commit operations
  runner.ts                      # timed sandboxed deterministic commands
  report.ts                      # terminal summary and report.md
  app-server/
    client.ts                    # thin JSONL JSON-RPC client
    generated/                   # generated protocol files and version marker
test/
  unit/
  integration/
demo/
  payment-retry-template/        # dependency-light TypeScript golden scenario
scripts/
  generate-protocol.ts
  setup-demo.ts
```

Treat this layout as provisional. Keep modules small, but prefer a working vertical slice over preserving this exact tree.

## 6. Persistent run model

```text
.safechange/runs/<run-id>/
  state.json
  context.json
  evidence.json
  contract.json
  plans/<planner-id>.json
  eligibility.json
  decision.json
  harness.json
  commands.json
  verification.json
  report.md
  logs/<phase>.log
```

`state.json` stores the current phase, final status, baseline fingerprint, branch and commit ids, retry count, and artifact hashes. `context.json` stores role, thread id, parent C0 thread id, turn id, and status for traceability only.

Every role artifact ultimately has a common envelope with run id, baseline commit, contract version when available, role, input artifact hashes, evidence references, assumptions, unknowns, and the typed payload. The first slice may persist a smaller envelope, but local schema validation is mandatory. Atomic writes, complete hashes, and recovery metadata are added before release.

`INSUFFICIENT_VERIFICATION_ENVIRONMENT` is represented as final status `BLOCKED` with that stable reason code, because it is a reason in the specification rather than a separate final status.

## 7. Delivery stages

### Stage 0: Bootstrap and protocol contract

1. Add the npm package, strict TypeScript configuration, build/typecheck/test scripts, executable bin entry, and CLI help.
2. Start with `ajv` for runtime validation and TypeScript/Node types for development. Add another small dependency only when it removes meaningful implementation risk or glue; audit the final set in Stage 4.
3. Add a protocol generation script using:

   ```text
   codex app-server generate-ts --out <generated-dir>
   codex app-server generate-json-schema --out <generated-dir>
   ```

4. Record the generator's `codex --version`. During development, provide one command to regenerate from the standard installed Codex; strict mismatch failure is added in Stage 4.
5. Implement the smallest JSONL client that completes one real thread/turn: handshake (`initialize`, then `initialized`), request-id correlation, notifications, turn completion, timeout/interrupt, and process-exit handling. Add concurrent requests only when planner parallelism is enabled later.
6. Add focused fake-server tests and one opt-in live smoke test. Do not build the exhaustive protocol failure suite before the first successful turn.

**Stage gate:** `npm run build`, `npm run typecheck`, and `npm test` pass; `safechange --help` works; one live opt-in App Server turn completes or reports a concrete environment/authentication error.

**Development checkpoint:** commit D1 before starting the planning workflow.

### Stage 1: Read-only plan tournament

1. Implement preflight checks:
   - target is a Git repository with a valid `HEAD`;
   - current branch and baseline commit are recorded;
   - tracked/staged state is clean;
   - no merge, rebase, cherry-pick, or bisect is in progress;
   - standard Codex App Server is available and protocol-compatible;
   - no target write or repository command has occurred.
2. Build the initial baseline fingerprint from `HEAD`, tracked/index status, relevant manifests, and repository instruction files. Add protected configuration fingerprints during Stage 4; never place secret contents in prompts or reports.
3. Start D0 as a new read-only/network-off thread. Produce and validate `EvidenceArtifact` with facts, commands, test gaps, instruction constraints, references, assumptions, and unknowns.
4. Start C0 as a separate new read-only/network-off thread with only user intent, validated evidence, and critical constraints. Produce and validate a `ChangeContract` with stable criterion/invariant ids, allowed scope, approval-required changes, non-goals, risks, and unknowns.
5. Treat C0's completed turn as immutable. Fork N planner threads directly from C0. Use minimal-change, reversible-change, and risk-first lenses for N=3; for N=1 or 2 take the first lenses, and for N=4 or 5 add testability-first and operations-first.
6. Run planners sequentially at first; they remain independent because each is a direct C0 fork. Add concurrency after request-correlation tests pass and only when demo latency warrants it. Each planner returns the same `DetailedPlan` shape and cannot see another planner's transcript.
7. Apply pure eligibility gates before the Judge:
   - every acceptance criterion id is covered;
   - every protected invariant is addressed;
   - verification commands and safety checks are present;
   - proposed paths fit allowed scope;
   - dependency, manifest, migration, API, permission, or secret changes are declared;
   - critical unknowns and recovery steps are explicit;
   - approval-required changes cause `HUMAN_DECISION_REQUIRED`, not silent eligibility.
8. Fork Judge from C0 and give it only eligible validated plans plus gate results. Require a winner, concrete rejections/trade-offs, remaining risk, and no numerical score. If no plan is eligible, stop with `BLOCKED`.
9. Persist every phase and produce `report.md` plus a short terminal summary.
10. Recheck that `HEAD`, index, refs, and tracked files equal preflight state. Tool-owned `.safechange` output is allowed.

**Stage gate:** a live opt-in smoke test produces materially different plans from one C0 checkpoint, selects or explicitly blocks, leaves tracked repository state unchanged, and makes all lineage and artifacts inspectable.

**Development checkpoint:** commit D2 before any write workflow is implemented.

### Stage 2: Golden demo and safety-harness write path

1. Create `demo/payment-retry-template` with a small npm/TypeScript service, deterministic fake payment provider, public API contract, and baseline tests. The missing behavior is retry after a transient timeout without a duplicate charge.
2. `scripts/setup-demo.ts` copies the template to a disposable directory, initializes a repository, creates B0, and prints the exact SafeChange command. This is demo setup, not core worktree management.
3. Before any write, recompute the currently supported baseline fingerprint. Any difference produces `BASELINE_CHANGED`.
4. Create `safechange/<run-id>` from B0 in the current checkout. Verify the new branch and clean tracked state before starting the writer.
5. Fork Test Author from C0 with workspace-write/network-off policy and the validated contract, selected plan, evidence gaps, and test-only scope.
6. Validate its actual diff before commit:
   - only approved test/fixture paths changed;
   - no production, instruction, manifest, lockfile, migration, secret, or protected file changed;
   - no `skip`/`only` or weakened existing assertion;
   - harness metadata names the targeted command and expected baseline signal.
7. Run the fixed targeted safety command with a timeout. During development this may use the trusted demo runner; sandbox enforcement is added in Stage 4. For this feature scenario, require the new acceptance test to fail for the expected missing-behavior reason on B0.
8. Commit the approved harness as T1 and store hashes of every T1 path.

**Stage gate:** the demo history is exactly B0 -> T1; T1 contains meaningful failing-first safety coverage and only approved test/fixture changes.

**Development checkpoint:** commit D3 in the SafeChange repository before implementing production changes in the demo flow.

### Stage 3: One implementation and straight independent verification

1. Fork Implementer from C0, never from Planner, Judge, or Test Author. Supply only validated artifacts, T1 id, allowed scope, and current Git state.
2. After the Implementer turn, fail closed unless:
   - all T1 path hashes are unchanged;
   - actual paths fit selected-plan scope;
   - no undeclared dependency, manifest, lockfile, migration, API, permission, instruction, or secret change exists;
   - tracked state contains only the intended implementation.
3. Scope expansion returns `REPLAN_REQUIRED`; approval-sensitive change returns `HUMAN_DECISION_REQUIRED`. Do not add the repair loop yet and never auto-revert invalid changes.
4. Commit the accepted implementation as I1.
5. Run the demo's fixed targeted tests, full tests, typecheck, and build with timeouts and captured exit codes/stdout/stderr.
6. Compare B0, T1, and I1 and persist:
   - changed paths and diff;
   - package/lockfile and migration changes;
   - protected and instruction-file changes;
   - T1 file hashes;
   - every command's argv, timeout, and exit code.
7. Fork Verifier directly from C0 with read-only/network-off policy. Give it the contract, selected plan, Judge constraints, commit ids, actual diff, deterministic results, and residual unknowns, but no Implementer transcript or self-assessment.
8. Require a schema-valid verdict for contract fulfillment, invariant preservation, scope conformance, evidence limits, and residual risks.
9. Report development success only when all required exits are zero, Git/protected gates pass, and the Verifier accepts. Until Stage 4 security and release gates exist, do not expose that result as the product status `VERIFIED`.

**Stage gate:** the demo history is exactly B0 -> T1 -> I1; I1 does not modify T1 files; one plan is implemented; real commands pass; an independent Verifier accepts the actual diff.

**Development checkpoint:** commit D4 before adding broad safety and recovery behavior.

### Stage 4: Hardening, recovery, and demo readiness

1. Make generated/runtime Codex version equality a strict preflight release gate and add protocol-drift tests.
2. Replace trusted-demo command execution with structured argv validation, `shell: false`, a sanitized non-interactive environment, bounded logs, and network-disabled Codex sandbox execution. Sandbox failure returns `BLOCKED`.
3. Complete baseline/configuration fingerprints, artifact envelopes, hashes, atomic writes, lineage checks, and explicit status/exit-code mapping.
4. Add planner concurrency only if needed for the three-minute demo and test out-of-order App Server responses before enabling it.
5. Resume only after completed phase boundaries. Revalidate all input hashes, baseline/branch/commit expectations, protocol version, and role lineage before reusing an artifact.
6. Add at most one Verifier-requested repair when the defect is local and within selected scope. Resume the same Implementer, create a new implementation commit without rewriting T1 or user history, rerun all checks, and create a fresh Verifier fork from C0.
7. Add the negative gates and fixtures for dirty/changed baseline, protected-test edits, undeclared dependency, scope expansion, timeouts, malformed artifacts, and failed commands.
8. On interruption, keep the target branch and working tree untouched, record the last confirmed phase, and report a safe manual next action. Do not claim rollback of ignored files, services, databases, queues, or external APIs.
9. Add README installation, authentication prerequisite, CLI examples, demo setup/run, artifact guide, status/exit-code table, security boundary, and expected three-minute demo flow.
10. Audit dependencies and package the compiled CLI so judges can install and run it without compiling TypeScript. Keep live-Codex tests opt-in; default tests remain deterministic.
11. Run the golden demo from a fresh setup at least twice and retain one sanitized sample report. Measure duration and trim prompts/output only after correctness is stable.

**Stage gate:** a new user can install the package, prepare the demo, run the command, inspect T1/I1 and `report.md`, and understand either success or the exact stop reason.

At this gate, and not earlier, the full passing workflow may emit `VERIFIED`.

**Development checkpoint:** commit D5 as the MVP candidate; subsequent release fixes remain separate commits.

## 8. Test strategy

### Unit tests

- JSONL framing, out-of-order responses, concurrent turns, notifications, malformed messages, process exit, timeout, and interrupt.
- Every artifact schema, envelope hash, atomic write, invalid artifact, and resume mismatch.
- Eligibility coverage, scope rules, dependencies/migrations, unknowns, and human-decision gates.
- Git clean/dirty/in-progress checks, fingerprints, branch creation, path diffs, commit ids, and T1 immutability.
- Runner argv validation, `shell: false`, sanitized environment, timeout, truncation, non-zero exit, and sandbox failure.
- Status-to-exit-code mapping and report rendering.

### Integration tests

- A fake App Server verifies that D0 and C0 use different `thread/start` calls and that every decision role uses `thread/fork` with C0 as parent.
- Invalid model output is rejected locally even when the fake server claims turn success.
- Planner reads may overlap; Test Author, Implementer, and repair writes cannot overlap.
- A temporary Git fixture verifies that plan mode changes no tracked state and write mode produces separate T1/I1 commits.

### Opt-in end-to-end tests

- Standard Codex plus the generated protocol version against the payment demo.
- Happy path: three distinct plans, admissible winner, failing-first harness, implementation, all commands passing, independent `VERIFIED` result.
- Negative path: dirty baseline, changed baseline, all plans ineligible, protected harness edit, undeclared dependency, unexpected path, failed verification, and protocol mismatch.

## 9. Acceptance mapping

- **Stage 1:** specification criteria 1-7 and the read-only first result from `START_HERE.md`.
- **Stage 2:** criteria 8-11 plus baseline revalidation, one-writer, and test-first invariants.
- **Stage 3:** criteria 12-18 on the straight no-repair golden path.
- **Stage 4:** criteria 19-20 plus release-grade sandboxing, invalidation, recovery, repair, negative gates, and demo packaging.
- **From the first slice:** strict TypeScript, validated role artifacts, deterministic evidence, no destructive Git behavior, and no production/external writes.
- **Before `VERIFIED` is enabled:** explicit network-disabled sandbox policy and every remaining release gate in Stage 4.

## 10. Known risks and minimal responses

- **App Server protocol changes:** regenerate freely from the standard installed Codex during development; enforce generated/runtime equality before release; no compatibility shim in MVP.
- **Model output still invalid under `outputSchema`:** local Ajv validation and one same-role correction attempt; then explicit failure.
- **Plans differ only cosmetically:** start with lens-specific prompts and inspect artifacts from real runs. Add a deterministic overlap gate only if observed failures justify it; never invent diversity or a winner.
- **Repository scripts are hostile or require network/secrets:** sandbox smoke test, sanitized environment, command allowlist, and `BLOCKED` when the proof environment is insufficient.
- **Protected-test semantic comparison is unreliable:** make every T1 path immutable during I1.
- **Model requests a broader change:** stop with `REPLAN_REQUIRED`; do not widen scope inside the repair loop.
- **Current repository has no baseline commit:** create the project's initial commit as a deliberate human/development action before implementation work that depends on Git history. SafeChange itself must never auto-commit pre-existing user files.
- **Three-minute demo latency:** parallelize only planner turns, keep prompts/artifacts compact, reuse one App Server process, and optimize only after a repeatable correct run exists.

## 11. Completion definition

The MVP is complete only when the packaged CLI repeatedly drives the prepared demo from B0 to a runnable SafeChange branch with separate T1 and I1 commits, preserved protected tests, real recorded command exits, an independent Verifier verdict, and a concise report. Every failure path must leave inspectable state and name a concrete next action; no model statement alone may produce `VERIFIED`.
