import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

import { runAuthCdpCapture } from '../../../src/pipeline/authTrace/cdpLive/runAuthCdpCapture.js';

const TEST_DIR = path.resolve('.tmp-auth-cdp-capture-test');

describe('runAuthCdpCapture', () => {
  test('captures auth artifacts from cdp wrapper commands', async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });

    const calls = [];
    const runCdp = jest.fn(async ({ args, cdpPort }) => {
      calls.push({ args, cdpPort });
      if (args[0] === 'snap') return '[button] Continue';
      if (args[0] === 'html') return '<html></html>';
      if (args[0] === 'net') return '120ms  1000B  fetch  https://auth.openai.com/api/accounts/authorize';
      if (args[0] === 'evalraw') return JSON.stringify({ cookies: [], url: 'https://auth.openai.com/log-in-or-create-account' });
      if (args[0] === 'nav') return 'Navigated';
      if (args[0] === 'shot') return 'Saved screenshot to file';
      return '';
    });

    const listPages = jest.fn(async () => ([{
      targetId: 'ABCDEF1234567890',
      targetIdPrefix: 'ABCDEF12',
      title: 'Login',
      url: 'https://auth.openai.com/log-in-or-create-account',
    }]));

    const createRecorder = jest.fn(async () => ({
      captureBoundary: jest.fn(async (phase) => ({
        phase,
        capturedAt: '2026-03-16T02:30:00.000Z',
        url: 'https://auth.openai.com/log-in',
        title: 'Welcome back - OpenAI',
        readyState: 'complete',
        referrer: '',
        cookies: [],
        storage: { localStorage: {}, sessionStorage: {} },
        eventCounts: {},
      })),
      stop: jest.fn(async () => ({ stoppedAt: '2026-03-16T02:31:00.000Z', eventCounts: {} })),
    }));

    const result = await runAuthCdpCapture({
      artifactDir: TEST_DIR,
      label: 'cdp-auth-test',
      scenario: 'signup-new',
      startUrl: 'https://auth.openai.com/log-in-or-create-account',
      cdpPort: 41565,
    }, {
      runCdpCommand: runCdp,
      listPages,
      createRecorder,
      waitForEnter: async () => {},
      now: () => new Date('2026-03-16T02:30:00.000Z'),
    });

    expect(result.status).toBe('ok');
    expect(calls.some(({ args }) => args[0] === 'list')).toBe(true);
    expect(calls.some(({ args }) => args[0] === 'nav')).toBe(true);
    expect(calls.every(({ cdpPort }) => cdpPort === 41565)).toBe(true);

    const summary = JSON.parse(await readFile(path.join(result.runDir, 'summary.json'), 'utf8'));
    expect(summary.captureMode).toBe('chrome-cdp-live');
    expect(summary.target.targetIdPrefix).toBe('ABCDEF12');
    expect(summary.cdpPort).toBe(41565);

    const snapshot = await readFile(path.join(result.runDir, 'phases', 'auth-page-loaded', 'snapshot.txt'), 'utf8');
    expect(snapshot).toContain('Continue');
  });
});
