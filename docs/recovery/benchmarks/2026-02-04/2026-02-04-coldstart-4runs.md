# Cold-Start Benchmark Report (2026-02-04)

Command per run:

```bash
export USER_DATA_DIR=$(mktemp -d)
MAX_RUN_MS=300000 STEP_TIMEOUT_MS=60000 HEADLESS=true STEALTH=true node --env-file=.env src/index.js
```

## Per-run results

| Run | Exit | Total (s) | t(LOGIN_EMAIL) | t(OTP_VERIFICATION) | t(CHAT_INTERFACE) | t(CHECKOUT) | t(subscribe reaction) | Log |
|-----|------|-----------|----------------|---------------------|-------------------|-------------|------------------------|-----|
| 1 | PASS (ec=0) | 78 | 6.2 | 16.4 | 40.2 | 49.3 | 60.7 | docs/recovery/benchmarks/2026-02-04/logs/run-1.log |
| 2 | PASS (ec=0) | 68 | 6.4 | 15.9 | 38.6 | 45.8 | 52.3 | docs/recovery/benchmarks/2026-02-04/logs/run-2.log |
| 3 | PASS (ec=0) | 80 | 7.4 | 18.2 | 40.6 | 56.5 | 64.0 | docs/recovery/benchmarks/2026-02-04/logs/run-3.log |
| 4 | PASS (ec=0) | 87 | 6.4 | 17.5 | 36.9 | 54.8 | 71.7 | docs/recovery/benchmarks/2026-02-04/logs/run-4.log |


## Summary stats (total runtime, seconds)

- samples: [68,78,80,87]
- avg: 78.3
- min: 68
- max: 87
- p95-ish: 87
