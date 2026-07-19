# Published Spark pilot evidence

This directory contains the retained Tenant Leak and Restart Storm development pairs
from 2026-07-19. They use `gpt-5.3-codex-spark` at medium effort and are not final or
statistically significant measurements.

Double Charge is intentionally excluded because its retained pair predates the
deterministic command-output fix in commit `1a3184c`. Its outcome remains documented
in [`../../RESULTS.md`](../../RESULTS.md) without presenting it as current-product
golden evidence.

## Integrity

Each run has an immutable `evidence-manifest.json`; each analysis has an
`analysis-manifest.json` bound to the evidence manifest. `report.json` and `report.md`
are derived only from those verified packages.

Before publication, all four runs passed `benchmark replay`, the report was regenerated,
and the exact directory passed:

```sh
gitleaks detect --no-git --source bench/golden/spark-pilot --redact
```

No leaks were found. The generated report hashes were:

- JSON: `445b5a635c41ee96cdeba980e001f691a9b5c915a7a08d3b655c6a9828e665ab`;
- Markdown: `01ea9e084da0dc0fdf12a2e973e5b188b431ecb6c17208c6c2b531dea482c20d`.

## Replay

Replay one run without a model or network call:

```sh
npm run benchmark -- replay \
  --results bench/golden/spark-pilot \
  --run restart-storm-changesafely-20260719154846674-ac381eee
```

Regenerate the paired report:

```sh
npm run benchmark -- report --results bench/golden/spark-pilot
```

Absolute temporary workspace paths may remain in exact runtime messages. They contain
no credentials and are preserved because redaction would invalidate the evidence
manifest.
