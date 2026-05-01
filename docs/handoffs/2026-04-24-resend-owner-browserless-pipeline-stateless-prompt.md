# Stateless Agent Prompt: Resend Owner Browserless Pipeline

Use this prompt for a new stateless agent that has no prior conversation context.

```text
You are a coding agent taking over a local repository task. You have no prior context. Read this prompt fully before acting.

Repository:
/home/epistemophile/Development/chatgpt-factory-bundle/.recovered-source/deterministic-agentmail-pipeline-clone/final-consolidated-browserless-pipeline-recovery

Git root:
/home/epistemophile/Development/chatgpt-factory-bundle

Ultimate goal:
Complete and prove a fully browserless OpenAI Business alias onboarding pipeline using Resend receiving.

Required flow:
openai_1@epistemophile.store owner OTP login via Resend -> discover/select existing OpenAI Business workspace -> invite a new openai_N@epistemophile.store alias -> alias OTP login via Resend -> alias accepts invite through backend API -> alias is registered into ~/.pi/agent/auth.json and ~/.pi/agent/account-router.json -> owner and alias membership/router verification passes.

Hard constraints:
- No browser runtime for the final pipeline.
- Do not use Playwright, Puppeteer, Chrome, CDP, agent-browser, or any browser automation as the production path.
- Do not use Cloudflare receiving.
- Do not use AgentMail receiving for @epistemophile.store aliases.
- Use Resend receiving for owner OTPs, alias OTPs, and invite emails.
- No manual OTP entry.
- No password is available for openai_1@epistemophile.store.
- Do not modify Codex source code.
- Do not print secrets, API keys, access tokens, refresh tokens, cookies, or full JWTs.

Local secrets:
/home/epistemophile/Development/chatgpt-factory-bundle/.env contains RESEND_API_KEY and RESEND_FROM_EMAIL=onboarding@epistemophile.store.

Network/Codex prerequisite:
Plain /home/epistemophile/bin/codex has been patched to disable the bwrap network sandbox and use Codex LB. Before live work, run:
check-codex-network
codex-smoke

If check-codex-network prints EPERM, you are inside a network-disabled parent sandbox. Stop using that shell and start from a normal shell. If it prints ECONNREFUSED for 127.0.0.1:9, that is good because sockets work and only that test port is closed.

Important docs to read first:
1. .omx/plans/prd-resend-owner-browserless-pipeline.md
2. .omx/plans/test-spec-resend-owner-browserless-pipeline.md
3. docs/superpowers/specs/2026-04-24-resend-owner-browserless-pipeline-requirements.md
4. docs/superpowers/plans/2026-04-24-resend-owner-browserless-pipeline.md
5. .omx/context/resend-owner-browserless-pipeline-20260424T015756Z.md

Primary files:
- src/cli/resend-owner-onboard-alias.js
- src/pipeline/authTrace/resendReceiving.js
- src/pipeline/authTrace/openaiAuthReplay.js
- src/pipeline/rotation/browserlessMemberOnboarder.js
- src/pipeline/rotation/browserlessWorkspaceClient.js
- src/pipeline/rotation/routerOnboarder.js
- src/pipeline/rotation/piAccountRegistrar.js

Primary tests:
- tests/pipeline/authTrace/resendReceiving.test.js
- tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js
- tests/pipeline/authTrace/openaiAuthReplay.test.js
- tests/pipeline/rotation/browserlessMemberOnboarder.test.js
- tests/pipeline/evidence/resendNotifier.test.js
- tests/cli/resendOwnerOnboardAlias.test.js

Known current implementation:
- src/pipeline/authTrace/resendReceiving.js already lists/retrieves Resend received emails, filters by exact recipient, extracts six-digit OTPs, and polls fresh OTPs.
- src/cli/resend-owner-onboard-alias.js already allocates aliases, signs owner in or reuses auth, discovers workspace, creates/reuses invites, calls router onboarding, and returns JSON.
- src/pipeline/rotation/browserlessMemberOnboarder.js already supports Resend invite polling for @epistemophile.store addresses.
- src/pipeline/rotation/routerOnboarder.js registers aliases and verifies Pi router/auth state.

Known risk:
The direct owner auth replay previously reached /log-in/password and did not produce a fresh OTP using a guessed fallback endpoint. The likely next implementation work is stabilizing browserless owner OTP trigger and validating it live.

Do not stop at unit tests. The work is complete only after:
1. check-codex-network succeeds.
2. codex-smoke succeeds with gpt-5.5.
3. Focused Jest suite passes:
   npm test -- tests/pipeline/authTrace/resendReceiving.test.js tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js tests/pipeline/authTrace/openaiAuthReplay.test.js tests/pipeline/rotation/browserlessMemberOnboarder.test.js tests/pipeline/evidence/resendNotifier.test.js tests/cli/resendOwnerOnboardAlias.test.js --runInBand
4. node src/cli/resend-owner-onboard-alias.js --dry-run selects a valid fresh alias.
5. node src/cli/resend-owner-onboard-alias.js completes live with status "onboarded".
6. The onboarded alias appears in ~/.pi/agent/auth.json.
7. The onboarded alias appears in ~/.pi/agent/account-router.json.
8. Owner listUsers(workspace.id) includes the alias.
9. Alias getAccounts() includes the workspace.

Execution approach:
Use superpowers:executing-plans or superpowers:subagent-driven-development. Follow docs/superpowers/plans/2026-04-24-resend-owner-browserless-pipeline.md task-by-task. Use focused tests before and after changes. Keep patches narrow. Preserve AgentMail behavior for non-epistemophile.store addresses. Preserve router/auth schemas. If live upstream changed, capture redacted HTTP status, host/path, normalized error code, and response preview, then patch the smallest relevant module.

First commands:
cd /home/epistemophile/Development/chatgpt-factory-bundle/.recovered-source/deterministic-agentmail-pipeline-clone/final-consolidated-browserless-pipeline-recovery
check-codex-network
codex-smoke
npm test -- tests/pipeline/authTrace/resendReceiving.test.js tests/pipeline/authTrace/openaiAuthReplayPasswordBranches.test.js tests/pipeline/authTrace/openaiAuthReplay.test.js tests/pipeline/rotation/browserlessMemberOnboarder.test.js tests/pipeline/evidence/resendNotifier.test.js tests/cli/resendOwnerOnboardAlias.test.js --runInBand
node src/cli/resend-owner-onboard-alias.js --dry-run

Final response requirements:
State changed files, tests run, live commands run, live alias onboarded or exact blocker, and remaining risks. Do not claim completion without live onboarding proof.
```
