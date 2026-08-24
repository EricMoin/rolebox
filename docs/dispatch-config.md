# Dispatch Configuration

> Part of the rolebox documentation. See [README](../README.md) for overview.

## Dispatch block in role.yaml

Override defaults for subagent dispatch via the `dispatch:` block:

```yaml
dispatch:
  maxInputTokensPerRequest: number  # Max cumulative input tokens per request (default: unlimited / opt-in)
  maxOutputTokensPerRequest: number # Max cumulative output tokens per request (default: unlimited / opt-in)
  maxCostPerRequest: number         # Max cumulative cost (USD) per request (default: unlimited / opt-in)
  maxInputTokensPerSession: number  # Max input tokens per dispatched session (default: unlimited / opt-in)
  maxCostPerSession: number         # Max cost (USD) per dispatched session (default: unlimited / opt-in)
  budgetSampleIntervalMs: number    # Budget sampling interval in ms (default: 30000)
  backgroundStaleTimeoutMs: number  # Stale timeout for background tasks (default: 900000)
  syncPromptTimeoutMs: number       # Timeout for sync prompt (default: 600000)
```

## Dispatch environment variables

Override dispatch configuration globally via environment variables (takes precedence over role.yaml `dispatch:` block):

| Variable | Description | Default |
|---|---|---|
| `ROLEBOX_DISPATCH_BG_STALE_MS` | Background stale timeout (ms) | 900000 |
| `ROLEBOX_DISPATCH_MATERIALIZE_TIMEOUT_MS` | Result fetch timeout (ms) | 10000 |
| `ROLEBOX_DISPATCH_RESULT_RETENTION_MS` | Result file retention (ms) | 3600000 |
| `ROLEBOX_DISPATCH_MAX_INPUT_TOKENS_PER_REQUEST` | Max cumulative input tokens per request | unlimited / opt-in |
| `ROLEBOX_DISPATCH_MAX_OUTPUT_TOKENS_PER_REQUEST` | Max cumulative output tokens per request | unlimited / opt-in |
| `ROLEBOX_DISPATCH_MAX_COST_PER_REQUEST` | Max cumulative cost (USD) per request | unlimited / opt-in |
| `ROLEBOX_DISPATCH_MAX_INPUT_TOKENS_PER_SESSION` | Max input tokens per dispatched session | unlimited / opt-in |
| `ROLEBOX_DISPATCH_MAX_COST_PER_SESSION` | Max cost (USD) per dispatched session | unlimited / opt-in |
| `ROLEBOX_DISPATCH_BUDGET_SAMPLE_INTERVAL_MS` | Budget sampling interval (ms) | 30000 |
| `ROLEBOX_METRICS` | Enable dispatch metrics (set to any truthy value) | unset |

## Environment variable interpolation

Use `{env:VARIABLE_NAME}` anywhere in role.yaml. Resolved at startup.

```yaml
model: "{env:PREFERRED_MODEL}"
prompt: |
  You work for {env:COMPANY_NAME}...
```
