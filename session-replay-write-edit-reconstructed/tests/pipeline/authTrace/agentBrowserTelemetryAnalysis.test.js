import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { analyzeAgentBrowserTelemetry } from '../../../src/pipeline/authTrace/agentBrowserTelemetryAnalysis.js';

const TEST_DIR = path.resolve('.tmp-agent-browser-telemetry-analysis-test');

async function writeJsonl(filePath, rows) {
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

describe('analyzeAgentBrowserTelemetry', () => {
  test('writes deterministic report and browserless bootstrap plan from agent-browser telemetry', async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    const runDir = path.join(TEST_DIR, 'run');
    await mkdir(runDir, { recursive: true });

    await writeJsonl(path.join(runDir, 'critical-requests.jsonl'), [
      {
        url: 'https://chatgpt.com/auth/login_with',
        method: 'GET',
        status: 200,
        responseHeaders: {
          server: 'cloudflare',
          'set-cookie': '__Host-next-auth.csrf-token=csrf-value%7Chash; Path=/; HttpOnly\n__Secure-next-auth.callback-url=https%3A%2F%2Fchatgpt.com; Path=/; HttpOnly\n__cf_bm=bm1; Path=/; Domain=chatgpt.com',
        },
      },
      {
        url: 'https://chatgpt.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js',
        method: 'GET',
        status: 200,
        responseHeaders: { server: 'cloudflare' },
      },
      {
        url: 'https://chatgpt.com/cdn-cgi/challenge-platform/h/g/jsd/oneshot/token/ray',
        method: 'POST',
        status: 200,
        responseHeaders: {
          server: 'cloudflare',
          'set-cookie': 'cf_clearance=clear123; Path=/; Domain=chatgpt.com\n__cf_bm=bm2; Path=/; Domain=chatgpt.com',
        },
      },
      {
        url: 'https://chatgpt.com/api/auth/providers',
        method: 'GET',
        status: 200,
        responseHeaders: {},
      },
      {
        url: 'https://chatgpt.com/api/auth/csrf',
        method: 'GET',
        status: 200,
        responseHeaders: {
          'set-cookie': '__Secure-next-auth.callback-url=https%3A%2F%2Fchatgpt.com%2Fauth%2Flogin_with; Path=/; HttpOnly',
        },
        responseBody: { text: '{"csrfToken":"csrf-value"}' },
      },
      {
        url: 'https://chatgpt.com/api/auth/signin/openai?prompt=login',
        method: 'POST',
        status: 200,
        postData: 'callbackUrl=https%3A%2F%2Fchatgpt.com%2Fauth%2Flogin_with&csrfToken=csrf-value&json=true',
        responseHeaders: {
          'set-cookie': '__Secure-next-auth.state=state-123; Path=/; HttpOnly',
        },
      },
      {
        url: 'https://auth.openai.com/api/accounts/authorize?prompt=login',
        method: 'GET',
        status: 200,
        responseHeaders: {},
      },
    ]);

    await writeFile(path.join(runDir, 'recorder-summary.json'), JSON.stringify({
      eventCounts: { 'Network.requestWillBeSent': 7 },
      jsExceptions: [],
      challengeSignals: [{ kind: 'cloudflare-response', url: 'https://chatgpt.com/auth/login_with' }],
    }, null, 2));
    await writeFile(path.join(runDir, 'url-history.txt'), 'https://auth.openai.com/log-in\nhttps://chatgpt.com/auth/login_with\n');

    const result = await analyzeAgentBrowserTelemetry(runDir);

    expect(result.report.loginWith.status).toBe(200);
    expect(result.report.cloudflare.clearanceCookiePresent).toBe(true);
    expect(result.report.nextAuth.csrfToken).toBe('csrf-value');
    expect(result.report.bootstrap.restartedLogin).toBe(true);
    expect(result.plan.cookieJar.cookies.map((cookie) => cookie.name)).toEqual(expect.arrayContaining([
      '__Host-next-auth.csrf-token',
      '__Secure-next-auth.callback-url',
      '__Secure-next-auth.state',
      'cf_clearance',
    ]));
    expect(result.plan.sequence.map((step) => step.name)).toEqual([
      'login_with',
      'providers',
      'csrf',
      'signin_openai',
      'authorize_prompt_login',
    ]);
    expect(result.plan.sequence.find((step) => step.name === 'authorize_prompt_login').usePreviousJsonUrl).toBe(true);

    const savedReport = JSON.parse(await readFile(path.join(runDir, 'agent-browser-report.json'), 'utf8'));
    expect(savedReport.cloudflare.challengeRequestCount).toBe(2);

    const savedPlan = JSON.parse(await readFile(path.join(runDir, 'browserless-bootstrap-plan.json'), 'utf8'));
    expect(savedPlan.cookieJar.cookies.find((cookie) => cookie.name === 'cf_clearance').value).toBe('clear123');
  });
});
