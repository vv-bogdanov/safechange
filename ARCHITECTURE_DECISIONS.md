# ChangeSafely - recorded architecture decisions

**Status:** active MVP decisions. These are revisable defaults, not immutable prohibitions.

This document preserves decisions already made and why they were chosen. When new evidence warrants a change, update the decision with the smallest documented diff in the same commit; a separate proposal phase is not required.

## AD-01. Product: orchestration and verification, not a new coding agent

**Decision:** ChangeSafely manages the process around Codex: contract, competing plans, safety harness, implementation, and independent verification.

**Why:** the project's value is in organizing a change safely, not in duplicating Codex's code-writing capabilities.

## AD-02. The primary interface is a CLI

**Decision:** build a standalone TypeScript CLI; add a Codex Skill as a thin entry point after the CLI stabilizes.

**Why:** a CLI is natural for developer and DevOps workflows, quick to build, easy to demonstrate, and does not require UI debugging.

## AD-03. TypeScript / Node.js

**Decision:** implement the project core in TypeScript.

**Why:** it supports convenient testing and npm packaging and fits local developer tooling well. This decision applies to the ChangeSafely CLI, not to the language of repositories it changes.

## AD-04. Codex App Server instead of an SDK or direct `codex exec`

**Decision:** use `codex app-server` over `stdio` JSON-RPC.

**Why:** ChangeSafely requires precise `thread/fork` behavior at a checkpoint, session trees, per-turn output schemas, and explicit sandbox policies. The direct CLI would require too much process and protocol glue, while the public SDK surface is not the basis for the required fork graph.

**Constraint:** implement a thin runtime client, not a general-purpose SDK.

## AD-05. Reproducible protocol baseline

**Decision:** generate and verify TypeScript and JSON Schema artifacts against an exact Codex development/CI version. At runtime, use the standard `codex` from `PATH`, validate the handshake and messages actually used, and do not block execution solely because the version string differs.

**Why:** an exact development baseline preserves reproducibility, while runtime validation stops real incompatibilities without forcing users onto a specific Codex build every day.

## AD-06. `stdio`, not WebSocket

**Decision:** use local `stdio` transport.

**Why:** it is the stable, minimal, and safe option for a local CLI. The MVP does not need WebSocket transport.

## AD-07. Two root contexts

**Decision:** Scratch Discovery `D0` and Canonical Contract `C0` are separate new threads.

**Why:** Discovery contains noise, intermediate hypotheses, and potential errors. Forking every role from it would make one error common to the whole tree.

## AD-08. `C0` is the only canonical fork point

**Decision:** Planners, Judge, Test Author, Implementer, and Verifier fork from the completed `C0` checkpoint.

**Why:** roles receive the same understanding of the task while retaining independent subsequent histories.

## AD-09. Implementer does not inherit a Planner transcript

**Decision:** Implementer forks from `C0` and receives the selected plan as a validated artifact.

**Why:** the detailed plan must be self-contained. Inheriting the transcript increases confirmation bias and hides implicit assumptions.

## AD-10. Verifier does not inherit the Implementer transcript

**Decision:** Verifier forks from `C0` and receives the contract, plan, actual diff, and deterministic results.

**Why:** verification must evaluate the original task, not continue the implementation author's explanation.

## AD-11. `N` independent plans, one implementation

**Decision:** `N` is configurable, defaults to 3, and has a reasonable MVP limit of 5. Each Planner develops an approach and detailed plan through its assigned lens. Only the winning plan is implemented.

**Why:** this provides solution diversity without triple implementation cost or conflicts among multiple implementations.

## AD-12. No separate Approach Generator in the standard workflow

**Decision:** each independent Planner creates both its high-level approach and detailed plan.

**Why:** a single idea generator becomes a diversity bottleneck and adds an unnecessary node. A broader ideation mode can be added later.

## AD-13. Formal gates before the LLM Judge

**Decision:** first exclude plans using mandatory criteria, then have the Judge compare eligible plans. The Judge prefers the admissible plan with the strongest executable evidence and lowest unresolved safety risk; simplicity is a tie-breaker after safety sufficiency.

**Why:** the Judge should not decide alone what can be checked formally. Do not use pseudo-precise numerical scores.

## AD-14. Characterization and change harnesses before implementation

**Decision:** a separate Test Author first creates a protected baseline-green characterization harness in `C1`. When the task intentionally changes behavior, the same Test Author then adds a protected baseline-red acceptance or regression harness in `T1`. A pure refactor may use `C1` as its final safety harness. Both stages complete before any production-code change.

**Why:** characterization proves what must remain intact, while a separate red harness proves the requested delta. Keeping both ahead of implementation prevents tests from being tailored to code already written and avoids mixing preservation evidence with expected failure evidence.

## AD-15. One write actor

**Decision:** planners may work in parallel; the characterization Test Author, change-harness continuation, harness review, and Implementer work sequentially.

**Why:** parallel writes to one checkout create conflicts, unstable state, and complex coordination.

## AD-16. Deterministic runner outside the LLM

**Decision:** ordinary code performs test, typecheck, lint, build, and Git checks.

**Why:** a model assertion cannot replace real exit codes and a real diff.

## AD-17. Current checkout plus a separate branch

**Decision:** ChangeSafely works in the current checkout and creates a branch before the first write; the MVP core does not manage worktrees.

**Why:** this preserves the configured environment, `.env`, dependencies, and local services. Worktree setup adds avoidable problems with ignored files, ports, volumes, and dependencies.

## AD-18. Clean tracked baseline

**Decision:** dirty tracked or staged state blocks the run; ChangeSafely never automatically stashes, resets, or cleans.

**Why:** a safety tool must not unilaterally manage a user's uncommitted changes.

## AD-19. Separate evidence and implementation commits

**Decision:** `C1` contains the baseline-green characterization harness, optional `T1` contains the baseline-red change harness, and `I1` contains the implementation. A pure refactor may proceed directly from `C1` to `I1`.

**Why:** this makes preservation evidence, requested behavioral change, and production code separately observable and reversible.

## AD-20. Limited rollback guarantee

**Decision:** the MVP guarantees a return to baseline tracked source code, not external state.

**Why:** a branch cannot roll back databases, volumes, queues, or external APIs. Production writes are therefore excluded.

## AD-21. Persisted run state without a database

**Decision:** store state and artifacts under `.changesafely/runs/<run-id>/`.

**Why:** the workflow is long and may be interrupted; ordinary JSON and Markdown are sufficient for the MVP.

## AD-22. Cache is an optimization, not a dependency

**Decision:** the identical `C0` prefix and fork graph should help prompt caching, but the workflow must remain correct without a cache hit.

**Why:** cache routing is not a logical guarantee.

## AD-23. Skill after CLI

**Decision:** complete the CLI first, then add a repository or user skill, and consider a plugin only as a distribution mechanism.

**Why:** the workflow and deterministic logic belong in the application; a skill must not replace the runtime.

## AD-24. Golden path before universality

**Decision:** start with one controlled TypeScript payment/retry demo, then improve robustness, and expand only afterward.

**Why:** the hackathon goal is a finished, runnable product; broad unfinished support is worse than one convincing scenario. The demo is the first validation target, not a permanent product boundary.

## AD-25. One explicit model per run

**Decision:** all roles in a run use the same selected model. The public CLI defaults
to `gpt-5.6-sol`, records the exact model in run provenance, and permits an explicit
whole-run override. Per-role model routing is deferred until benchmark evidence shows
a material benefit.

**Why:** a uniform model keeps comparisons explainable and removes routing policy from
the MVP while preserving a simple override for development runs.

## AD-26. Target-language independence through repository capabilities

**Decision:** keep orchestration, artifacts, Git boundaries, role isolation, and
verification independent of target source syntax. Authorize deterministic project
commands from an immutable baseline capability catalog containing exact argv, cwd,
check kind, test paths, control files, and source attribution. Small built-in detectors
provide zero-configuration support for proven toolchains; the versioned tracked root
`changesafely.config.json` covers other and polyglot repositories. A model may select a
catalog command but cannot create, broaden, or mutate command authority during a run.

**Why:** per-language orchestration duplicates owned code, while arbitrary
model-proposed shell commands break the fail-closed execution boundary. A small data
contract preserves the workflow's strength, supports multiple toolchains in one
repository, and keeps runtime/process safety centralized.

**Rollout:** prepared npm JavaScript/TypeScript, Python/pytest, config-driven make, and
Node/Python polyglot repositories, plus PHP through explicit config, have end-to-end
fixtures. PHP did not justify a Composer detector. Practical support for additional
toolchains is claimed only after the corresponding fixture passes.

## AD-27. High assurance is the only product mode

**Decision:** ChangeSafely treats every target task as high risk. It has no reduced-assurance,
fast, or vibe-coding mode. Model cost and latency are measured, but cannot weaken evidence or
verification gates.

**Why:** the multi-role workflow has material overhead and differentiated value only when a missed
regression, side effect, or scope error matters. A cheaper weak mode would blur the product contract
without serving its intended users.

## AD-28. Broad inspection and proof, narrow production writes

**Decision:** Discovery, planning, Test Author, and Verifier inspect the complete relevant
behavioral and operational impact surface. The selected plan and Implementer still use the smallest
sufficient production write scope. A write allowlist never restricts read-only investigation.

**Why:** legacy coupling, shared state, side effects, callers, and operational behavior often live
outside the obvious edit. Broadening the production diff to match broad analysis would create a
different risk, so inspection and write scope must remain asymmetric.

## AD-29. Independent harness review before implementation

**Decision:** after C1 and optional T1, reuse the existing Verifier runtime in a fresh read-only C0
fork to challenge assertion provenance, critical-risk coverage, non-interference evidence, and
plausible green-but-wrong implementations. Test Author may make at most two bounded corrections.
Implementation cannot begin until this review accepts the harness.

**Why:** final verification cannot recover safety evidence that was missing before protected tests
were committed. Reusing Verifier preserves context independence without adding a role framework.

## AD-30. Exhaustive risk search, conservative assertions

**Decision:** roles search broadly across applicable behavior, state, effects, failures, time, and
boundaries. Every non-obvious expected behavior must be grounded in the task or repository evidence;
unresolved critical semantics stop the workflow.

**Why:** generic requests for maximal safety can otherwise create invented test oracles. Wide risk
discovery and strict assertion provenance are both required for a trustworthy harness.

## AD-31. Traceable contracts fail closed before writes

**Decision:** criteria, invariants, risks, and unknowns use stable IDs, evidence bases, explicit
relationships, criticality, and resolution status. Deterministic gates reject duplicate or unknown
references, missing critical-risk mitigation, and unresolved critical unknowns before creating a
write branch. Contract path prefixes constrain planned writes, not read-only discovery or
verification.

**Why:** model booleans and prose lists cannot prove that a selected plan covers the actual safety
contract. Explicit relationships make omissions inspectable while leaving semantic exploration to
the roles.

**Compatibility:** new artifacts use format v3. Hash-verified v2 contracts and plans are normalized
for reading; missing provenance is labeled as migrated, and legacy unknowns remain critical and
unresolved instead of receiving an invented resolution.
