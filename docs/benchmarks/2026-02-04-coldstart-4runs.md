# Cold-Start Benchmark Report (2026-02-04)

Command per run:

```bash
export USER_DATA_DIR=$(mktemp -d)
MAX_RUN_MS=300000 STEP_TIMEOUT_MS=60000 HEADLESS=true STEALTH=true node --env-file=../../.env src/index.js
```

## Per-run results

| Run | Exit | Total (s) | t(LOGIN_EMAIL) | t(OTP_VERIFICATION) | t(CHAT_INTERFACE) | t(CHECKOUT) | t(subscribe reaction) | Log |
|-----|------|-----------|----------------|---------------------|-------------------|-------------|------------------------|-----|
| 1 | PASS (ec=0) | 94 | 6.3 | 16.1 | 58.6 | 65.1 | 76.6 | docs/benchmarks/logs/2026-02-04/run-1.log |
| 2 | PASS (ec=0) | 90 | 6.8 | 17.8 | 34.7 | 61.9 | 71.8 | docs/benchmarks/logs/2026-02-04/run-2.log |
| 3 | PASS (ec=0) | 103 | 16.3 | 27.7 | 51.1 | 61.6 | 80.4 | docs/benchmarks/logs/2026-02-04/run-3.log |
| 4 | PASS (ec=0) | 86 | 6.6 | 16.2 | 36.8 | 48.9 | 68.4 | docs/benchmarks/logs/2026-02-04/run-4.log |


## Summary stats (total runtime, seconds)

- samples: [86,90,94,103]
- avg: 93.3
- min: 86
- max: 103
- p95-ish: 103
