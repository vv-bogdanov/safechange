# SafeChange

[![CI](https://github.com/vv-bogdanov/safechange/actions/workflows/ci.yml/badge.svg)](https://github.com/vv-bogdanov/safechange/actions/workflows/ci.yml)
[![CodeQL](https://github.com/vv-bogdanov/safechange/actions/workflows/codeql.yml/badge.svg)](https://github.com/vv-bogdanov/safechange/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/vv-bogdanov/safechange/badge)](https://scorecard.dev/viewer/?uri=github.com/vv-bogdanov/safechange)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

SafeChange is a local TypeScript CLI that compares independent implementation
plans, creates a protected failing-first safety harness, implements one selected
plan, and verifies the resulting Git branch from a clean Codex context.

It is deliberately narrow: one prepared npm/TypeScript repository, one branch,
one plan, real command exits, inspectable artifacts, and explicit safe stops.

## Why SafeChange

- **Alternatives before edits.** Independent planners fork from one canonical
  contract; deterministic eligibility gates run before the Judge.
- **Tests before production code.** Test Author creates and commits T1 before the
  Implementer can change production paths. T1 hashes remain protected.
- **Independent verification.** Verifier forks from C0 rather than inheriting the
  Implementer transcript and receives the actual diff and command evidence.

## Quick Start

Until the first npm registry release, install from the repository:

```sh
git clone https://github.com/vv-bogdanov/safechange.git
cd safechange
npm ci --ignore-scripts
npm run build
npm link
safechange --help
```

The package is prepared for tokenless, provenance-backed npm releases. Once
`0.1.0` is published, the CLI will run without a checkout:

```sh
npx safechange@0.1.0 --help
```

SafeChange uses the authenticated `codex` executable on `PATH`. It does not
override the user's default model.

## Compatibility

| Component | Supported baseline |
| --- | --- |
| Node.js | Active LTS 22 and 24 |
| Codex CLI | Exact version in `protocol-version.json`, currently `0.144.6` |
| Git | Named branch, valid HEAD, clean tracked and staged state |
| Target | Prepared npm-based TypeScript repository |
| Host | Linux release path; other hosts are not yet qualified |

The App Server protocol is generated from the pinned Codex build. Runtime and
generated versions must match; SafeChange fails preflight on drift.

## Workflow

```mermaid
flowchart LR
  D0[Scratch Discovery D0] --> E[Evidence]
  E --> C0[Canonical Contract C0]
  C0 --> P1[Planner 1]
  C0 --> P2[Planner 2]
  C0 --> P3[Planner 3]
  C0 --> J[Judge]
  P1 --> G[Eligibility gates]
  P2 --> G
  P3 --> G
  G --> J
  C0 --> T[Test Author]
  J --> T
  T --> T1[T1 safety commit]
  C0 --> I[Implementer]
  T1 --> I
  I --> I1[I1 implementation commit]
  C0 --> V[Verifier]
  I1 --> V
  V --> R[Report and runnable branch]
```

D0 and C0 are separate root threads. Planners, Judge, Test Author,
Implementer, and Verifier fork from the completed C0 checkpoint and exchange
schema-validated artifacts rather than hidden role transcripts. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## CLI

Compare plans without changing tracked target state:

```sh
safechange plan --repo /path/to/repo --task "Describe the requested change" --plans 3
```

Run the full test-first workflow:

```sh
safechange run --repo /path/to/repo --task "Describe the requested change" --plans 3
```

Resume only from a validated persisted boundary:

```sh
safechange resume --repo /path/to/repo --run <run-id>
```

SafeChange never stashes, cleans, resets, amends, or rewrites user history.

## Golden Demo

Prepare a disposable payment-retry repository:

```sh
safechange-demo --target /tmp/safechange-payment-demo
safechange run \
  --repo /tmp/safechange-payment-demo \
  --plans 3 \
  --task "Retry a payment once after a transient timeout without allowing a duplicate charge"
```

A successful history is `B0 -> T1 -> I1`: baseline, protected safety harness,
and one implementation. An optional bounded repair adds one commit without
rewriting history.

```sh
git -C /tmp/safechange-payment-demo log --oneline --reverse
cat /tmp/safechange-payment-demo/.safechange/runs/<run-id>/report.md
```

Two fresh live rehearsals completed in 118.90 and 122.30 seconds. The sanitized
evidence is in [`docs/RELEASE_REHEARSAL.md`](docs/RELEASE_REHEARSAL.md) and
[`docs/sample-report.md`](docs/sample-report.md).

Live performance tests can opt into Spark without changing the product default:

```sh
SAFECHANGE_LIVE_TEST_MODEL=gpt-5.3-codex-spark safechange run \
  --repo /tmp/safechange-payment-demo \
  --plans 3 \
  --task "Retry a payment once after a transient timeout without allowing a duplicate charge"
```

## Artifacts

Runs are stored under `.safechange/runs/<run-id>/`:

- `state.json` and `context.json`: phase, status, Git state, hashes, and role lineage.
- `evidence.json`, `contract.json`, `plans/*.json`, `eligibility.json`, and
  `decision.json`: the read-only plan tournament.
- `harness.json` and `commands.json`: protected T1 paths and failing-first evidence.
- `implementation.json`, optional `repair.json`, command evidence, and
  `verification.json`: the actual change and independent verdict.
- `report.md`: concise outcome, residual risks, and next action.

Writes are atomic. Resume revalidates artifact hashes and lineage, protocol
version, expected branch and commits, baseline ancestry, and protected T1 files.

## Status And Exit Codes

| Status | Exit | Meaning |
| --- | ---: | --- |
| `PLANNED` | 0 | Read-only planning selected one eligible plan. |
| `VERIFIED` | 0 | Release gates and independent verification passed. |
| `BLOCKED` | 2 | A safety or verification-environment gate stopped the run. |
| `BASELINE_CHANGED` | 2 | B0 no longer matches planning evidence. |
| `REPLAN_REQUIRED` | 2 | Implementation exceeded the selected scope. |
| `HUMAN_DECISION_REQUIRED` | 2 | A sensitive change needs explicit approval. |
| `FAILED` | 1 | A command, artifact, role, or internal workflow step failed. |

## Security Boundary

- AI roles and repository commands use network-disabled sandbox policies.
- Repository commands use structured argv, `shell: false`, a sanitized
  non-interactive environment, timeouts, real exit codes, and bounded logs.
- SafeChange core does not add `.env`, `.env.local`, or `.npmrc` contents to
  prompts. Repository scripts can still read files available to local developer
  tools and may print them into persisted command output.
- SafeChange protects tracked Git changes. It does not roll back ignored files,
  services, databases, queues, containers, volumes, or external systems.
- Production credentials, deployments, destructive migrations, external writes,
  worktree management, web UI, GitHub App, and MCP are outside this release.

Read [`SECURITY.md`](SECURITY.md) and the full
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) before using SafeChange on
sensitive code.

## Development

```sh
npm run check
npm run typecheck
npm run test:coverage
npm run protocol:check
npm run security:audit
npm run security:signatures
npm run package:smoke
```

Default tests use a local fake App Server. Live Codex checks remain opt-in. See
[`CONTRIBUTING.md`](CONTRIBUTING.md), [`CHANGELOG.md`](CHANGELOG.md), and the
original [`SAFECHANGE_SPEC.md`](SAFECHANGE_SPEC.md) for more detail.
