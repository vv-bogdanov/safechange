# ChangeSafely Risk Suite specification

## 1. Context

ChangeSafely is a change-assurance tool for coding agents. The user describes a change, after which the system:

1. explores the repository and records the change contract;
2. considers several independent implementation options;
3. selects the minimally sufficient and safely verifiable option;
4. identifies the likely blast radius of the selected plan;
5. adds missing tests for affected behavior, interfaces, and invariants;
6. implements one selected plan;
7. verifies the actual diff with ordinary project commands and an independent Verifier;
8. returns an evidence-backed Git branch ready for review.

The product MVP already exists separately. This specification covers only the evaluation suite that must demonstrate measurable value from the workflow.

## 2. Why custom benchmarks are needed

Conventional coding benchmarks primarily ask:

> Can an agent create a patch that passes the supplied tests?

ChangeSafely addresses a narrower, different problem:

> Can the workflow recognize the dangerous blast radius of a small change, build the missing safety net, and avoid accepting a plausible but unsafe green patch?

This requires scenarios where:

- the change is small;
- the first obvious solution looks reasonable;
- current tests are insufficient;
- an incorrect patch can pass visible checks;
- several realistic approaches exist;
- the consequences of failure are disproportionately large;
- correctness can be checked deterministically.

Ready-made general-purpose benchmarks do not measure these properties directly. The MVP therefore uses a small open set of targeted assurance scenarios.

This must not be presented as proof of ChangeSafely's universal superiority. The correct description is:

> **A transparent pilot evaluation of change-assurance behavior.**

After the hackathon, the suite may be extended with a preregistered subset of SWE-bench Multilingual or another external benchmark.

## 3. Goal

Create a reproducible evaluation suite that fairly compares:

1. **Codex Direct** - ordinary task execution by one coding-agent workflow;
2. **ChangeSafely** - the complete planning, impact-analysis, test-first safety-harness, and independent-verification workflow.

The benchmark must show:

- whether the user task was completed;
- whether critical adjacent invariants were preserved;
- whether an unsafe-green result occurred;
- whether generated tests catch known unsafe implementations;
- whether the patch exceeded allowed scope;
- how much time and compute each mode required.

## 4. Core hypothesis

For small changes with a large blast radius, ChangeSafely should produce **safe task success** more often and **unsafe-green patches** less often than a direct coding-agent workflow.

The evaluation must also account for the cost of assurance:

- wall-clock time;
- active model time and deterministic command time;
- number of model turns;
- total, input, cached input, non-cached input, output, and reasoning tokens, when available;
- correction turns, command/tool calls, failures, and timeouts;
- generated artifact volume;
- provider-reported cost, when available;
- diff size.

Additional time and tokens are not automatically considered a defect. They are a measured tradeoff.

## 5. What the benchmark must not claim to prove

The suite is not intended to claim that ChangeSafely:

- guarantees the absence of all errors;
- prevents every production incident;
- outperforms other systems on every coding task;
- performs formal verification;
- completely discovers blast radius;
- replaces code review, staging, or production monitoring.

It measures only the stated properties on five published scenarios.

## 6. MVP scope

The MVP includes:

- three small TypeScript scenarios, one CommonJS legacy scenario, and one Python scenario;
- two execution modes;
- one deterministic evaluator;
- hidden invariants inaccessible to the agent during execution;
- prepared unsafe mutants;
- artifact capture for every run;
- a final comparative report;
- result replay without calling the model again.

It does not include:

- hundreds of tasks;
- a statistically significant study;
- SWE-bench integration;
- web dashboard;
- distributed runner;
- leaderboard;
- support for many languages;
- production infrastructure;
- a complex rating system.

## 7. Compared modes

### 7.1 Codex Direct

One ordinary coding-agent workflow receives the task and repository.

It may:

- explore the code;
- change production code;
- add tests when it considers them necessary;
- run available project commands;
- perform self-review.

It does not receive:

- hidden tests;
- evaluator oracle;
- unsafe mutants;
- internal ChangeSafely artifacts.

Direct mode must not be artificially weakened with a poor prompt or a ban on tests.

### 7.2 ChangeSafely

Use the product's normal MVP workflow:

- contract;
- several independent plans;
- plan selection;
- impact map;
- evidence gaps;
- safety tests before implementation;
- implementation;
- deterministic checks;
- independent verification.

ChangeSafely does not receive hidden tests or the benchmark oracle.

## 8. Fair-comparison principles

Both modes use the same:

- task text;
- baseline commit;
- model;
- reasoning effort;
- Codex version;
- available tools;
- sandbox and network policy;
- environment;
- maximum runtime;
- visible project checks.

Important:

- do not manually correct a patch;
- do not delete failed runs;
- do not rerun solely because a result is poor;
- classify technical failures in advance;
- retain both attempts after an allowed technical rerun;
- physically keep the hidden evaluator outside the agent-accessible workspace;
- derive every published result from retained raw artifacts.

Do not artificially equalize tokens: additional compute is part of the product and must be shown honestly.

### 8.1 Exact Direct prompt

Direct receives the selected task card verbatim, without an additional implementation hint,
test requirement, or requested strategy. For Double Charge the complete prompt is:

```text
Make payment retries idempotent.
Keep the public API unchanged.
Do not add a production dependency.
```

The task bytes stored in the comparison manifest are also passed as ChangeSafely's `--task`
value. Direct remains free to inspect the repository, add tests, run checks, and self-review.

### 8.2 Outcome taxonomy

Every attempt receives exactly one machine-readable outcome:

- `safe_success`: visible checks, acceptance invariants, preservation invariants, and scope
  policy all pass;
- `unsafe_green`: visible checks pass while acceptance, preservation, or scope evaluation
  fails;
- `visible_failure`: the worker returns an evaluable snapshot whose visible checks fail;
- `scope_failure`: the requested behavior and visible checks pass, but an independently
  reportable forbidden change is present;
- `technical_failure`: the controller cannot produce or evaluate a trustworthy candidate
  because of process startup, transport, timeout, malformed runtime evidence, isolation,
  or evidence-integrity failure.

`scope_failure` takes precedence over `unsafe_green` when behavior passes and scope alone
fails. A visible-check failure takes precedence over hidden behavioral failures. Technical
failure is used only when the candidate cannot be evaluated reliably.

### 8.3 Attempts and technical reruns

The default is one attempt per scenario and mode. One replacement attempt is allowed only
when the original fails before an evaluable snapshot exists because the Codex process could
not start, the model service was unavailable, or the runtime transport disconnected. A hard
timeout, malformed model output after work began, evaluator failure caused by the candidate,
poor result, or failed checks is not rerunnable.

Every technical failure and allowed replacement is retained and reported. The replacement
does not erase the original and must reuse the same comparison manifest. No additional run
may be requested because an outcome is disappointing.

### 8.4 Registered pilot protocol

Before a paired run, create an immutable comparison manifest containing the exact task,
scenario version and manifest hash, baseline, Codex executable version, ChangeSafely version,
model, reasoning effort, runtime limit, sandbox, network policy, controller-owned preparation,
argv/cwd visible checks, target-toolchain version commands and results, environment, and
execution order. Reject the pair if either mode differs. Comparison manifest v2 stores these
structured commands. Evidence carrying the npm-only v1 contract remains readable and is never
rewritten or evaluated against newer scenario assets.

The pilot defaults are:

- order: Double Charge, Tenant Leak, Restart Storm, Legacy Spaghetti; Direct before
  ChangeSafely within each scenario;
- attempts: one, plus only the technical replacement defined above;
- maximum runtime: 60 minutes per attempt in both modes;
- model reasoning effort: `medium` in both modes;
- agent shell network: disabled;
- Sentry and remote ChangeSafely telemetry: disabled;
- worker execution: sequential, not concurrent.

Every scenario change first passes model-free fixture, reference, mutant, isolation, schema,
replay, and report checks. Live validation then starts with one ChangeSafely Spark smoke per new
toolchain. Complete paired Direct versus ChangeSafely development comparisons run only after the
relevant product path and benchmark portfolio are stable.

Final measured or publishable runs are forbidden until the version-matched Spark comparisons
have completed and been evaluated, and then require a separate explicit user command with both
`--final` and an explicit `--model`. The controller rejects `--final` until a paired evaluated
Spark comparison exists for the same scenario version. Final runs are never started by CI, a
default script, or completion of an implementation phase.

### 8.5 Isolation threat model

Treat the agent worker as untrusted code with shell access inside its assigned workspace. It
must be unable to read the controller checkout, hidden evaluator, reference patches, mutants,
task metadata beyond the selected public task, previous results, or a controller-owned canary.
Directory naming and prompt instructions are not security boundaries.

Each attempt runs in a fresh repository with no remote or parent-worktree link. The smallest
viable OS or container boundary exposes only that repository, the selected product build, the
Codex runtime, and minimal configuration. The controller retains evaluator and result-write
access and invokes evaluation only after the worker exits. Live execution is blocked unless a
no-model canary probe proves the same worker boundary cannot discover or read a controller-only
file.

## 9. Primary metrics

### 9.1 Safe Task Success - primary metric

A run is safely successful only when all of the following hold:

- acceptance criteria are satisfied;
- all hidden preservation invariants pass;
- no forbidden changes exist;
- protected tests were not weakened;
- the evaluator found no unacceptable side effect.

### 9.2 Unsafe Green

Visible/project checks pass, but one or more hidden invariants fail.

This is the most important failure mode for ChangeSafely:

```text
existing checks: green
real change safety: failed
```

### 9.3 Mutation Kill Rate

The share of prepared unsafe mutants detected by safety-harness tests.

Tests must:

- pass on the correct reference implementation;
- fail on at least the relevant unsafe mutants;
- verify behavior rather than one specific internal implementation.

### 9.4 Scope Discipline

Check for:

- unexpected production files;
- forbidden API changes;
- new dependencies;
- migrations;
- deployment-parameter changes outside the task;
- weakening or removal of protected tests.

### 9.5 Cost of assurance

Record:

- wall-clock time;
- number of model turns;
- token usage, when available;
- cached-token usage, when available;
- provider-reported cost, when available;
- production diff size;
- number of tests added.

Unavailable usage or cost values are stored as `null`, never inferred or estimated.

### 9.6 Diagnostic data

Useful data that need not be collapsed into one score:

- how many plans were created;
- which plans were rejected and why;
- which hazards were identified;
- which evidence gaps were closed by tests;
- how closely actual impact matched planned impact.

Do not create an artificial aggregate rating such as `Safety Score 93.4`.

## 10. Scenarios

### 10.1 Double Charge - finance and concurrency

User task:

> Make payment retries idempotent. Keep the public API unchanged and add no production dependency.

The scenario must model a small payment service where the retry flow can invoke an external gateway more than once.

Critical properties:

- repeating one operation token does not create a second charge;
- concurrent retries are safe across one or more service instances;
- behavior survives a simulated process restart;
- ambiguous persistence failure and gateway rejection remain recoverable;
- amount-only and currency-only conflicts are not concealed or charged;
- distinct operation tokens never share one provider result;
- normal payment and refund flows remain correct;
- the external gateway is called exactly the required number of times;
- the public API and production dependencies do not change.

Example unsafe mutants:

- process-local `Set`;
- check-then-insert race;
- an idempotency key derived from mutable payment details;
- a completed-looking placeholder persisted before the gateway succeeds;
- stored receipt reuse without input validation;
- one constant provider key shared by unrelated operations.

The project's primary demo must use this scenario.

### 10.2 Tenant Leak - security and trust boundaries

User task:

> Cache authorization checks to reduce database load without changing the public authorization API.

The system must account for a user identifier being unique only within a tenant.

Critical properties:

- the cache key includes the tenant boundary;
- equal user IDs in different tenants never intersect;
- composite keys cannot collide through delimiter-like identifiers;
- concurrent cold misses coalesce into one permission load;
- a shared cache is reused across service instances;
- permission grants and revocations take effect after version changes;
- positive and negative decisions are cached without collapsing permissions;
- deny-by-default is preserved;
- cache/storage errors do not become allow decisions;
- the public API does not change.

Example unsafe mutants:

- a cache key based only on `userId`;
- an ambiguous delimiter-based composite key;
- a request-scoped permission snapshot cached as a subject snapshot;
- a stale positive or negative cache without version validation;
- a process-local cache or missing single-flight loading;
- fail-open behavior on cache or backend error.

### 10.3 Restart Storm - DevOps and availability

User task:

> Stop routing traffic to the service while its database is unavailable.

The scenario contains a small service and Kubernetes-like deployment configuration.

Critical properties:

- a database outage makes readiness fail;
- a hanging database probe produces a bounded unready result;
- repeated transient failures remain unready and recover on the same instance;
- concurrent liveness and readiness do not couple their dependencies;
- liveness remains healthy for a live process;
- after database recovery, the service becomes ready without a restart;
- startup follows process transitions without querying the database;
- stopped probes do not query the database or mutate process state;
- replica count, image, resource limits, and unrelated deployment settings do not change;
- no destructive apply is executed.

Example unsafe mutants:

- database connectivity placed in the liveness probe;
- readiness and liveness using the same endpoint;
- sticky readiness after the first result;
- fail-open database errors;
- a database check in startup;
- an unbounded readiness probe;
- changing restart policy instead of readiness;
- an unrelated deployment configuration change.

### 10.4 Legacy Spaghetti - side-effect isolation

User task:

> Make preview repricing side-effect free. Keep the public API unchanged and add no production dependency.

The CommonJS fixture combines a local-looking preview change with shared module state,
mutable aliases, smuggled request parameters, callbacks, events, inventory, notifications,
auditing, legacy fallbacks, and cross-feature state.

Critical properties:

- preview returns the same price without persistence or external effects;
- inventory, audit, events, metrics, callbacks, and module-global state remain untouched;
- caller-owned input and nested aliases remain unchanged;
- the legacy preview fallback is returned once without partial effects;
- repeated previews and a neighboring commit remain isolated;
- commit and refund behavior remain unchanged;
- the CommonJS public API and production dependencies do not change.

Example unsafe mutants:

- shallow-cloning only the top-level order;
- using the stateful commit quote path for preview;
- treating audit or notification as a harmless preview side effect;
- checking the wrong request flag or returning too late;
- counting the legacy preview fallback as a committed repricing effect;
- invoking the callback without returning from the legacy flow.

### 10.5 Partial Replay - durable Python side effects

User task:

> Make partial batch replays resume safely. Keep the public API unchanged and add no production
> dependency.

The Python fixture combines inventory, ledger, notification, and callback effects with mutable
module state, dict-based parameter smuggling, import registration, mutable defaults, and broad
exception handling.

Critical properties:

- retry after failure at each effect boundary completes every effect exactly once;
- concurrent retries and new processor instances share durable progress;
- the same job id rejects conflicting item input without another effect;
- a smuggled resume key cannot merge unrelated jobs;
- callbacks occur exactly once and independent state stores do not share completion;
- caller input, module defaults, public API, and project controls remain unchanged.

## 11. Structure of each scenario

Each scenario package must logically contain:

1. **Baseline repository**
   A small, understandable project in the scenario's target language with existing visible
   tests.

2. **Task definition**
   A realistic user request with clear constraints but no implementation hint.

3. **Visible checks**
   Checks available to the agent workflow.

4. **Hidden evaluator**
   Acceptance and preservation invariants unavailable to the agent during the run.

5. **Reference solution**
   One correct patch used only to validate the benchmark.

6. **Unsafe mutants**
   Several plausible implementations that demonstrate an unsafe green result.

7. **Forbidden-change policy**
   Explicit scope boundaries.

8. **Scenario documentation**
   An explanation of the risk, oracle, and evaluation method.

Every discovered scenario directory also contains a schema-validated `scenario.json`. It
declares the scenario id and version, exact visible-check argv/cwd pairs, controller-owned
offline preparation, test path prefixes/patterns, and exact toolchain version commands.
Discovery is deterministic and fails when a scenario directory is incomplete. Preparation is
performed by the controller before the worker starts; workers never receive install permission.
Language-specific public-API, dependency, and forbidden-scope rules remain owned by the hidden
evaluator instead of pretending that one cross-language heuristic is reliable.

The baseline must be realistic enough to require exploration but small enough for fast, reproducible execution.

## 12. Hidden evaluator requirements

Hidden tests must:

- reside outside the model-accessible workspace;
- run only after the patch is complete;
- be fully deterministic;
- have no external-network dependency;
- produce a machine-readable result;
- distinguish acceptance failures from preservation failures;
- avoid requiring one specific implementation when several implementations are valid.

Before running models, verify that:

- the baseline predictably does not satisfy the new task;
- the reference patch passes every check;
- each mutant demonstrates its stated failure mode;
- at least one mutant in each scenario passes visible checks but fails the hidden evaluator.

The last condition creates a measurable unsafe-green risk.

## 13. Safety-test evaluation requirements

Tests created by the ChangeSafely Test Author are evaluated separately.

They must:

- be added before implementation;
- have no access to the hidden evaluator;
- pass on the reference implementation;
- catch relevant mutants;
- not be weakened by Implementer;
- remain part of the published run artifact.

Direct-mode tests are also retained and may be evaluated the same way when the agent adds them.

## 14. Run artifacts

Every run must leave an immutable evidence package containing:

- mode and scenario;
- exact task text;
- baseline commit;
- environment/version metadata;
- scenario-manifest, preparation-command, visible-command, and toolchain-version evidence;
- safe runtime events and final messages;
- final Git diff;
- added tests diff;
- visible-check results;
- hidden-evaluator results;
- mutation-evaluation results;
- scope violations;
- time/token/cost metadata;
- final verdict.

Evidence must not contain chain-of-thought, unrestricted JSON-RPC payloads, secrets, secret
files, or unbounded stdout/stderr. Direct evidence retains documented JSONL event fields and
the final answer. ChangeSafely evidence retains its structured trace and schema-validated
artifacts. Command evidence is bounded and redacted by the controller. Missing token or cost
data is stored as `null`. Forked ChangeSafely threads are measured from their inherited
checkpoint rather than by summing cumulative thread totals. Reasoning tokens are reported
as an output-token subset and are not added to the total a second time.

For ChangeSafely, also retain:

- Change Contract;
- candidate plans;
- selection decision;
- Impact Map;
- Evidence Gaps;
- verifier report.

Artifacts must have stable identifiers and hashes so that replay and the public report reference a specific run.

## 15. Runner and user workflow

Provide a minimal automated path that can:

- run one scenario in one mode;
- run the complete MVP suite;
- run the evaluator separately for a retained patch;
- verify the reference solution and mutants;
- replay retained results without a model;
- generate the final Markdown/JSON report.

The development interface is:

```text
npm run benchmark -- run --scenario double-charge --mode direct|changesafely [--model gpt-5.3-codex-spark]
npm run benchmark -- validate
npm run benchmark -- validate --scenario double-charge
npm run benchmark -- evaluate --run <run-id>
npm run benchmark -- replay --run <run-id>
npm run benchmark -- report [--results <path>]
```

The development `run` command defaults to Spark and accepts only Spark. After separate user
authorization, a final run requires both `--model <id>` and `--final`; it also requires an
evaluated paired Spark comparison for that scenario. No command implicitly starts a final
measured run.

The exact CLI and internal structure are left to the coding agent. Do not build a separate platform.

## 16. Final report

Reports present each scenario and its recorded toolchains first:

```text
Scenario: <id>    Toolchains: <runtime versions>
Mode              Outcome       Mutants killed   Scope   Time   Tokens
Codex Direct      _             _ / _            _       _      _
ChangeSafely      _             _ / _            _       _      _
```

Cross-language summaries may state scenario coverage and repeated qualitative patterns. They
must not collapse different languages and risks into a single language score.

Each scenario needs a short case card containing:

- risk;
- selected patch;
- visible result;
- hidden result;
- unsafe mutants;
- what ChangeSafely detected or missed;
- cost of the additional assurance.

Do not publish invented numbers or hide negative results.

## 17. Use in marketing materials

The benchmark should support these honest claims:

> Small diff. Big blast radius.

> Existing tests can be green while critical invariants are broken.

> ChangeSafely builds missing tests for the discovered impact surface before implementation.

> Tests, Git, and hidden invariants - not model confidence - determine the result.

> All tasks, prompts, patches, mutants, and run artifacts are published.

In the README and Devpost, call the results a pilot evaluation.

The video should focus primarily on one live Double Charge run. Briefly show the comparative table for the measured scenarios at the end.

## 18. Completion criteria

The benchmark MVP is complete when:

1. All five scenarios run locally and reproducibly.
2. Each scenario has a validated reference patch.
3. Each scenario has at least six meaningful unsafe mutants.
4. Each scenario has at least one unsafe-green mutant.
5. The hidden evaluator is inaccessible to the agent during the run.
6. Both Direct and ChangeSafely modes work.
7. Visible and hidden results are generated automatically.
8. Scope violations are checked automatically.
9. Mutation evaluation works for generated tests.
10. Raw artifacts, diff, environment, and usage are retained.
11. The complete suite can replay without a model.
12. One command builds the final report.
13. Results receive no manual correction.
14. Limitations and methodology are documented publicly.
15. The golden Double Charge run is suitable for the README and video.

## 19. Implementation priorities

Priority order:

1. Double Charge end-to-end.
2. One evaluator and artifact format.
3. Direct vs ChangeSafely comparison.
4. Tenant Leak.
5. Restart Storm.
6. Mutation evaluation.
7. Aggregate report and replay polish.

If time is limited:

- one excellent Double Charge scenario is better than three unstable ones;
- add Tenant Leak next;
- add Restart Storm third;
- do not sacrifice methodological honesty for quantity.

## 20. Future expansion

After the hackathon:

- preregistered JS/TS subset SWE-bench Multilingual;
- multiple repetitions per scenario;
- additional risk domains;
- community-contributed scenarios;
- one-planner vs multi-planner ablation;
- warm vs cold verifier comparison;
- CI integration;
- a public benchmark runner.

These capabilities must not complicate the MVP.
