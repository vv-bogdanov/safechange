# SafeChange

SafeChange is a local TypeScript CLI that compares several implementation plans,
adds a protected failing-first safety harness, implements one selected plan, and
independently verifies the resulting Git branch.

The MVP supports prepared npm-based TypeScript repositories and uses the Codex
App Server over local `stdio` as its only AI runtime.

## Prerequisites

- Node.js 22 or newer, npm, and Git.
- The standard `codex` executable available on `PATH` and authenticated for the
  current user.
- `codex --version` must match the version recorded in
  `src/app-server/generated/protocol-version.json`. Run
  `npm run protocol:generate` when intentionally developing against a new Codex
  version.

SafeChange does not select or override a Codex model. The user's normal Codex
model configuration applies. Bounded role turns use low reasoning effort after
release rehearsal showed it preserves the golden workflow while reducing
latency. The opt-in live-test model uses medium effort because Spark at low
effort did not reliably follow the structured command contract.

## Install

For development:

```sh
npm ci
npm run build
npm link
```

To build the installable archive used by a judge:

```sh
npm pack
npm install --global ./safechange-0.0.1.tgz
```

The archive contains the compiled CLI, generated protocol files, and this
README. The target machine does not need TypeScript to run it.

## CLI

Compare plans without changing tracked target state:

```sh
safechange plan --repo /path/to/repo --task "Describe the requested change" --plans 3
```

Run the complete workflow:

```sh
safechange run --repo /path/to/repo --task "Describe the requested change" --plans 3
```

Continue only from a validated persisted boundary:

```sh
safechange resume --repo /path/to/repo --run <run-id>
```

The target must start on a named branch with a valid `HEAD`, clean tracked and
staged state, and no Git operation in progress. SafeChange never stashes,
cleans, resets, amends, or rewrites user history.

## Golden Demo

Prepare a disposable payment-retry repository:

```sh
safechange-demo --target /tmp/safechange-payment-demo
safechange run \
  --repo /tmp/safechange-payment-demo \
  --plans 3 \
  --task "Retry a payment once after a transient timeout without allowing a duplicate charge"
```

The successful history is `B0 -> T1 -> I1`: the baseline, a protected safety
harness commit, and one implementation commit. A bounded repair, when requested
by the independent Verifier for an in-scope local defect, adds one repair commit
without rewriting those commits.

Inspect the result:

```sh
git -C /tmp/safechange-payment-demo log --oneline --reverse
cat /tmp/safechange-payment-demo/.safechange/runs/<run-id>/report.md
```

The intended live walkthrough is: setup, one `safechange run`, inspect T1/I1,
read `report.md`, and run the demo tests. Actual duration depends primarily on
Codex latency. The release rehearsal profile below completed two fresh N=3
golden runs in 118.90 and 122.30 seconds; see
[`docs/RELEASE_REHEARSAL.md`](docs/RELEASE_REHEARSAL.md).

Opt-in live CLI tests can use the faster Spark research-preview model without
changing the product default:

```sh
SAFECHANGE_LIVE_TEST_MODEL=gpt-5.3-codex-spark safechange run \
  --repo /tmp/safechange-payment-demo \
  --plans 3 \
  --task "Retry a payment once after a transient timeout without allowing a duplicate charge"
```

The selected test override is persisted in `state.json` and reused by `resume`.
Spark availability depends on the authenticated Codex account.

A sanitized successful output is retained in
[`docs/sample-report.md`](docs/sample-report.md).

## Artifacts

Each run is persisted under `.safechange/runs/<run-id>/`. Important files are:

- `state.json`: phase, status, B0/T1/implementation commits, repair count, and
  artifact hashes, plus any opt-in live-test model override.
- `context.json`: D0/C0 and fork/resume lineage.
- `evidence.json`, `contract.json`, `plans/*.json`, `eligibility.json`, and
  `decision.json`: the read-only tournament.
- `harness.json` and `commands.json`: protected T1 paths and failing-first
  baseline evidence.
- `implementation.json`, optional `repair.json`,
  `verification-commands*.json`, and `verification.json`: actual write and
  independent verification evidence.
- `report.md`: concise result, command exits, findings, residual risks, and next
  action.

Artifacts are schema-validated and atomically written. Resume rechecks their
hashes and lineage plus the expected Git branch, commit, clean state, protected
T1 hashes, baseline ancestry, and Codex protocol version.

## Status And Exit Codes

| Status | Exit | Meaning |
| --- | ---: | --- |
| `PLANNED` | 0 | Read-only planning completed and selected a plan. |
| `VERIFIED` | 0 | All release gates and independent verification passed. |
| `BLOCKED` | 2 | A safety or verification-environment gate stopped the run. |
| `BASELINE_CHANGED` | 2 | B0 no longer matches planning evidence. |
| `REPLAN_REQUIRED` | 2 | The requested implementation exceeded selected scope. |
| `HUMAN_DECISION_REQUIRED` | 2 | A declared sensitive change needs explicit approval. |
| `FAILED` | 1 | A command, artifact, role, or internal workflow step failed. |

Every normal run summary prints the phase, selected plan, status, report path,
available branch/commit ids, reason, and next action.

## Security Boundary

- AI roles and repository commands run with network access disabled. Release
  command evidence must come from the Codex sandbox wrapper, structured argv,
  `shell: false`, a sanitized non-interactive environment, real exit codes, and
  bounded logs.
- `.env`, `.env.local`, and `.npmrc` contents are never read into prompts or
  reports; only file metadata contributes to baseline invalidation.
- Repository scripts are untrusted code. The MVP runner permits only npm
  test/typecheck/build and `node --test` forms, with timeouts.
- Production credentials, deploy/apply actions, destructive migrations,
  external writes, worktree management, web UI, GitHub App, and MCP are outside
  the MVP.
- SafeChange protects tracked Git changes. It does not claim to roll back ignored
  files, services, databases, queues, volumes, or external systems.

## Development Checks

```sh
npm run typecheck
npm test
npm run protocol:check
npm pack --dry-run
```

Live Codex checks are deliberately opt-in; the default test suite uses a local
fake App Server.
