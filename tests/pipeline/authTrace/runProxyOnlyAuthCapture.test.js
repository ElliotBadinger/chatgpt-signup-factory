import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

import { runProxyOnlyAuthCapture } from '../../../src/pipeline/authTrace/deepCapture/runProxyOnlyAuthCapture.js';

const TEST_DIR = path.resolve('.tmp-proxy-only-auth-capture-test');

describe('runProxyOnlyAuthCapture', () => {
  test('orchestrates proxy-only capture and writes summary plus derived request artifacts', async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });

    const launchMitmproxy = jest.fn(async () => ({ port: 9988, cleanup: async () => {} }));
    const runCatalogAnalysis = jest.fn(async () => ({}));
    const waits = [];

    const result = await runProxyOnlyAuthCapture({
      artifactDir: TEST_DIR,
      label: 'proxy-only-test',
      scenario: 'signup-new',
      startUrl: 'https://auth.openai.com/log-in-or-create-account',
      proxyPort: 9988,
    }, {
      launchMitmproxy,
      runCatalogAnalysis,
      waitForEnter: async (msg) => { waits.push(msg); },
      now: () => new Date('2026-03-16T02:00:00.000Z'),
      readJsonLines: async () => ([
        {
          ts: 1,
          url: 'https://auth.openai.com/api/accounts/authorize?client_id=x',
          method: 'GET',
          requestheaders: { accept: 'text/html' },
          responseheaders: { location: 'https://auth.openai.com/create-account/password' },
          status: 302,
          requestBody: '',
          responseBody: '',
        },
        {
          ts: 2,
          url: 'https://chatgpt.com/api/auth/session',
          method: 'GET',
          requestheaders: { accept: 'application/json' },
          responseheaders: { 'content-type': 'application/json' },
          status: 200,
          requestBody: '',
          responseBody: '{"WARNING_BANNER":"x","accessToken":"y"}',
        },
      ]),
    });

    expect(launchMitmproxy).toHaveBeenCalled();
    expect(runCatalogAnalysis).toHaveBeenCalledWith(result.runDir, { dryRun: false });
    expect(waits.length).toBeGreaterThan(0);

    const summary = JSON.parse(await readFile(path.join(result.runDir, 'summary.json'), 'utf8'));
    expect(summary.captureMode).toBe('proxy-only-manual');
    expect(summary.manualLaunchCommand).toContain('--proxy-server=127.0.0.1:9988');

    const request1 = JSON.parse(await readFile(path.join(result.runDir, 'requests', 'request-1.json'), 'utf8'));
    const response2 = JSON.parse(await readFile(path.join(result.runDir, 'responses', 'response-2.json'), 'utf8'));
    expect(request1.url).toContain('/api/accounts/authorize');
    expect(response2.url).toContain('/api/auth/session');
  });
});
