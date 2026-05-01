# Sentinel / Golden Replay Recovery

This package contains the recovered browserless OpenAI/ChatGPT auth replay and live sentinel provider code.

Primary executable CLIs:

- `src/cli/pipeline-auth-openai-report.js`
  - analyzes a golden OpenAI auth trace and emits sentinel/header replay metadata.
- `src/cli/pipeline-auth-openai-replay.js`
  - replays OpenAI/ChatGPT auth browserlessly using the golden trace analysis.
  - supports existing-login OTP and signup-new branches.
  - uses `src/pipeline/authTrace/openaiSentinelProvider.js` to call `https://sentinel.openai.com/backend-api/sentinel/req` and inject live sentinel tokens into trace-derived header templates.

Core recovered modules:

- `src/pipeline/authTrace/openaiAuthTelemetryAnalysis.js`
- `src/pipeline/authTrace/openaiAuthReplay.js`
- `src/pipeline/authTrace/openaiSentinelProvider.js`
- `src/pipeline/authTrace/browserlessBootstrapReplay.js`
- `src/pipeline/authTrace/httpCookies.js`

Golden trace referenced by the recovered code/docs:

- `artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2`

Example command from recovered session evidence:

```bash
node src/cli/pipeline-auth-openai-report.js \
  --trace-dir artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2

node src/cli/pipeline-auth-openai-replay.js \
  --trace-dir artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2 \
  --email eagerstatus254@agentmail.to \
  --mode existing-login-otp \
  --artifact-dir artifacts/auth-replays/2026-03-16T20-23-24Z-eagerstatus254-existing-login-otp
```

Do not treat this as installed into the restored worktree until copied there intentionally.
