# Changelog

All notable changes to SafeChange are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-18

### Added

- Complete `plan`, `run`, and boundary-validated `resume` CLI workflows.
- Separate D0 and C0 roots with independent C0 planner, Judge, Test Author,
  Implementer, and Verifier forks.
- Schema-validated artifacts, deterministic eligibility gates, atomic persistence,
  lineage and hash verification, and concise Markdown reports.
- Protected failing-first T1, scoped I1, one bounded repair, and independent release
  verification on a SafeChange branch.
- Structured network-disabled command runner with sanitized environment, timeouts,
  bounded output, and real exit evidence.
- Payment-retry golden demo and installable `safechange-demo` binary.
- Node 22/24 CI, Biome, coverage thresholds, protocol drift checks, npm audit,
  registry signature verification, package smoke tests, CodeQL, dependency review,
  Dependabot, and OpenSSF Scorecard.

### Security

- Documented the local checkout, secret-file, ignored-state, external-state, and
  resource-exhaustion boundaries.
- Updated Ajv to `8.20.0`, resolving the published `$data` ReDoS advisory affecting
  earlier versions.

[0.1.0]: https://github.com/vv-bogdanov/safechange/releases/tag/v0.1.0
