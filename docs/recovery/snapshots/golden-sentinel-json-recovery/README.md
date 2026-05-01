# Golden Sentinel JSON Recovery

This package contains the recovered/reconstructed JSON files most likely meant by “the JSON golden sentinel file or similar”.

Recovered path layout:

- `artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2/openai-auth-report.json`
- `artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2/openai-auth-plan.json`

Important caveat: the full original golden trace directory (`trace.jsonl`, requests, responses, checkpoints, screenshots, etc.) is still absent from the live filesystem. The report JSON was recovered from session output. The plan JSON was reconstructed from the recovered source code’s plan builder and the recovered report.
