# Intelligence Pipeline Benchmark Suite

Evaluation dataset and runner for the intelligence extension's routing heuristics (complexity-decomposer + routing-authority).

## Purpose

This benchmark suite serves three goals:

1. **Train a learned routing classifier** — The labeled dataset provides ground-truth tier and pipeline assignments that a classifier can learn from, replacing the current keyword-weighted complexity scoring.
2. **Compare local vs API inference quality** — When local inference tiers go live, this dataset provides a standardized set of prompts to measure response quality across backends.
3. **Regression-test pipeline changes** — Any change to the routing heuristics, complexity decomposer, or routing authority can be validated against these 100 entries to ensure accuracy does not regress.

## Files

| File | Description |
|------|-------------|
| `suite.json` | 100 labeled evaluation entries |
| `runner.ts` | Benchmark runner script |
| `results.json` | Output from the last runner execution (gitignored or committed as baseline) |

## Running the benchmark

From the repository root:

```bash
pnpm --filter ./extensions/intelligence exec tsx benchmark/runner.ts
```

### Options

| Flag | Description |
|------|-------------|
| `--verbose` | Print predicted vs expected for every entry |
| `--category <name>` | Only evaluate entries in this category (trivial, simple, medium, hard, reasoning) |
| `--json` | Output raw JSON results to stdout instead of the human-readable report |

### Examples

```bash
# Full benchmark with verbose output
pnpm --filter ./extensions/intelligence exec tsx benchmark/runner.ts --verbose

# Only evaluate hard prompts
pnpm --filter ./extensions/intelligence exec tsx benchmark/runner.ts --category hard --verbose

# Machine-readable output for scripting
pnpm --filter ./extensions/intelligence exec tsx benchmark/runner.ts --json > latest-results.json
```

## Interpreting results

### Accuracy metrics

- **Tier accuracy** — percentage of entries where the predicted tier matches the expected tier. This is the primary metric for routing correctness.
- **Pipeline accuracy** — percentage of entries where simple/complex pipeline assignment matches expectations.

### Category breakdown

Shows accuracy per category (trivial, simple, medium, hard, reasoning). Expect:
- Trivial/simple categories should have high accuracy — these are straightforward routing decisions
- Hard/reasoning categories may have lower accuracy — these often need nuanced analysis that keyword heuristics miss

### Confusion matrix

Rows are expected tiers, columns are predicted tiers. Diagonal entries are correct predictions. Off-diagonal entries show systematic misrouting:
- If many "reasoning" entries are predicted as "medium", the heuristics under-escalate complex prompts
- If many "tiny" entries are predicted as "large", the heuristics over-escalate simple prompts

### Misclassified entries

Each misclassified entry shows:
- The expected vs predicted tier/pipeline
- The computed complexity score
- The detected domain
- The routing reason (which rule or threshold drove the decision)

This helps identify which heuristic rules cause the most misroutes.

## Adding new entries

Add entries to `suite.json` following this schema:

```json
{
  "id": "bench-101",
  "prompt": "The realistic user request",
  "category": "trivial | simple | medium | hard | reasoning",
  "domain": "auth | database | api | security | algorithm | infrastructure | general | null",
  "expectedTier": "tiny | small | medium | large | reasoning",
  "expectedPipeline": "simple | complex",
  "qualityCriteria": ["What a good response MUST contain"],
  "antiPatterns": ["What a bad response looks like"],
  "tags": ["freeform", "labels"]
}
```

### Guidelines for new entries

- **Realistic prompts** — Write prompts that developers actually ask, not synthetic test cases
- **Correct expectedTier** — This is where the request SHOULD be routed for optimal quality, not where the current heuristics send it
- **Meaningful quality criteria** — These will be used to evaluate response quality across different model tiers
- **Maintain distribution** — Keep roughly equal counts across categories and spread domains across categories
- **Increment IDs sequentially** — bench-101, bench-102, etc.

### Distribution targets

Categories (20 each): trivial, simple, medium, hard, reasoning

Domains (spread across categories):
- auth/security: ~15 entries
- database: ~12 entries
- api/middleware: ~15 entries
- algorithm/data-structures: ~10 entries
- infrastructure/devops: ~10 entries
- general/other: ~38 entries
