import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

import { runAuthCdpCapture } from '../../../src/pipeline/authTrace/cdpLive/runAuthCdpCapture.js';

const TEST_DIR = path.resolve('.tmp-auth-cdp-capture-instrumentation-test');

describe('runAuthCdpCapture instrumentation', () => {
  test('writes phase boundaries, cookies, storage, recorder summary, and bootstrap analysis', async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });

    const runCdpCommand = jest.fn(async ({ args }) => {
      if (args[0] === 'list') return 'ABCDEF12  Login  https://auth.openai.com/log-in-or-create-account\n';
      if (args[0] === 'snap') return '[button] Continue';
      if (args[0] === 'html') return '<html></html>';
      if (args[0] === 'net') return '120ms  1000B  fetch  https://auth.openai.com/api/accounts/authorize';
      if (args[0] === 'evalraw') return JSON.stringify({ result: { value: { url: 'https://auth.openai.com/log-in', title: 'Welcome back - OpenAI' } } });
      if (args[0] === 'nav') return 'Navigated';
      if (args[0] === 'shot') return 'Saved screenshot to file';
      return '';
    });

    const createRecorder = jest.fn(async () => ({
      captureBoundary: jest.fn(async (phase) => ({
        phase,
        capturedAt: '2026-03-16T18:00:00.000Z',
        url: 'https://auth.openai.com/log-in',
        title: 'Welcome back - OpenAI',
        readyState: 'complete',
        referrer: 'https://chatgpt.com/',
        cookies: [{ name: '__session', domain: 'auth.openai.com' }],
        storage: { localStorage: { a: '1' }, sessionStorage: { b: '2' } },
        eventCounts: { 'Network.requestWillBeSent': 10 },
      })),
      navigate: jest.fn(async () => 'Navigated'),
      snapshot: jest.fn(async () => '[button] Continue'),
      html: jest.fn(async () => '<html></html>'),
      resourceEntries: jest.fn(async () => '120ms  1000B  fetch  https://auth.openai.com/api/accounts/authorize'),
      pageMeta: jest.fn(async () => ({ result: { value: { url: 'https://auth.openai.com/log-in', title: 'Welcome back - OpenAI' } } })),
      screenshot: jest.fn(async () => 'Saved screenshot'),
      stop: jest.fn(async () => ({
        stoppedAt: '2026-03-16T18:01:00.000Z',
        eventCounts: { 'Network.requestWillBeSent': 12 },
        criticalRequests: [{ url: 'https://chatgpt.com/auth/login_with', status: 200 }],
        jsExceptions: [{ text: 'TypeError: boom' }],
        challengeSignals: [{ kind: 'cloudflare-challenge-script' }],
      })),
    }));

    const listPages = jest.fn(async () => ([{
      targetId: 'ABCDEF1234567890',
      targetIdPrefix: 'ABCDEF12',
      title: 'Login',
      url: 'https://auth.openai.com/log-in-or-create-account',
    }]));

    const result = await runAuthCdpCapture({
      artifactDir: TEST_DIR,
      label: 'cdp-auth-instrumented',
      scenario: 'signup-new',
      startUrl: 'https://auth.openai.com/log-in-or-create-account',
      cdpPort: 41565,
    }, {
      runCdpCommand,
      createRecorder,
      listPages,
      waitForEnter: async () => {},
      now: () => new Date('2026-03-16T18:00:00.000Z'),
    });

    const phaseBoundaries = JSON.parse(await readFile(path.join(result.runDir, 'phase-boundaries.json'), 'utf8'));
    expect(phaseBoundaries).toHaveLength(8);
    expect(phaseBoundaries[0].phase).toBe('auth-page-loaded');

    const cookies = JSON.parse(await readFile(path.join(result.runDir, 'phases', 'final', 'cookies.json'), 'utf8'));
    expect(cookies[0].name).toBe('__session');

    const storage = JSON.parse(await readFile(path.join(result.runDir, 'phases', 'final', 'storage.json'), 'utf8'));
    expect(storage.localStorage.a).toBe('1');

    const recorderSummary = JSON.parse(await readFile(path.join(result.runDir, 'network-recorder-summary.json'), 'utf8'));
    expect(recorderSummary.eventCounts['Network.requestWillBeSent']).toBe(12);

    const bootstrapAnalysis = JSON.parse(await readFile(path.join(result.runDir, 'bootstrap-analysis.json'), 'utf8'));
    expect(bootstrapAnalysis.loginWith.url).toContain('/auth/login_with');
    expect(bootstrapAnalysis.jsExceptions[0].text).toContain('boom');
    expect(bootstrapAnalysis.challengeSignals[0].kind).toContain('challenge');
  });
});
