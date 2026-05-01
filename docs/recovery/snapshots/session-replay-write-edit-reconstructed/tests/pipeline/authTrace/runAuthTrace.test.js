import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

import { runAuthTrace } from '../../../src/pipeline/authTrace/runAuthTrace.js';

describe('runAuthTrace', () => {
  test('creates run artifacts and writes summary in manual mode', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'run-auth-trace-'));
    const checkpoint = jest.fn(async (name) => ({
      name,
      url: name === 'auth-page-loaded' ? 'https://auth.openai.com/create-account/password' : 'https://chatgpt.com/',
      session: { hasAccessToken: name === 'final' || name === 'post-callback' },
      cookies: name === 'landing'
        ? [{ name: 'a', domain: 'x' }]
        : [{ name: 'a', domain: 'x' }, { name: 'b', domain: 'y' }],
    }));
    const attachTrace = jest.fn(() => ({ detach: async () => {} }));
    const launcher = jest.fn(async () => ({
      page: {
        goto: jest.fn(async () => {}),
        screenshot: jest.fn(async () => {}),
        cookies: jest.fn(async () => []),
      },
      browser: {},
      cleanup: jest.fn(async () => {}),
    }));

    const result = await runAuthTrace({
      artifactDir,
      mode: 'manual',
      scenario: 'signup-new',
      label: 'smoke',
      startUrl: 'https://chatgpt.com/',
    }, {
      launchBrowserSession: launcher,
      createCheckpointRecorder: () => ({ record: checkpoint }),
      attachTraceSession: attachTrace,
      runCatalogAnalysis: async () => ({}),
      now: () => new Date('2026-03-15T19:00:00.000Z'),
      waitForEnter: async () => {},
    });

    const summary = JSON.parse(await readFile(path.join(result.runDir, 'summary.json'), 'utf8'));
    const analysis = JSON.parse(await readFile(path.join(result.runDir, 'analysis.json'), 'utf8'));
    const cookieDiff = JSON.parse(await readFile(path.join(result.runDir, 'cookie-diffs', 'auth-page-loaded.json'), 'utf8'));
    expect(summary.mode).toBe('manual');
    expect(summary.scenario).toBe('signup-new');
    expect(summary.runId).toContain('smoke');
    expect(analysis).toMatchObject({ actualScenario: 'signup-new' });
    expect(cookieDiff).toHaveProperty('addedCookies');
    expect(checkpoint.mock.calls.map((call) => call[0])).toEqual([
      'landing',
      'auth-page-loaded',
      'email-submitted',
      'otp-page',
      'otp-submitted',
      'password-page',
      'password-submitted',
      'post-callback',
      'final',
    ]);
    expect(launcher).toHaveBeenCalled();
    expect(attachTrace).toHaveBeenCalled();
  });

  test('uses default local chrome launcher when dependency is omitted', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'run-auth-trace-'));
    const launchLocalChrome = jest.fn(async () => ({
      page: {
        goto: jest.fn(async () => {}),
        screenshot: jest.fn(async () => {}),
        cookies: jest.fn(async () => []),
      },
      browser: {},
      cleanup: jest.fn(async () => {}),
    }));

    await runAuthTrace({ artifactDir, label: 'default-launch' }, {
      launchLocalChrome,
      createCheckpointRecorder: () => ({ record: async (name) => ({ name, url: 'https://chatgpt.com/' }) }),
      attachTraceSession: () => ({ detach: async () => {} }),
      runCatalogAnalysis: async () => ({}),
      now: () => new Date('2026-03-15T19:00:01.000Z'),
      waitForEnter: async () => {},
    });

    expect(launchLocalChrome).toHaveBeenCalled();
  });

  test('runAuthTrace calls runCatalogAnalysis after capture when dependency is provided', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'run-auth-trace-'));
    const runCatalogAnalysis = jest.fn(async () => ({}));

    await runAuthTrace({ artifactDir, label: 'catalog-integration' }, {
      launchBrowserSession: async () => ({
        page: {
          goto: jest.fn(async () => {}),
          screenshot: jest.fn(async () => {}),
          cookies: jest.fn(async () => []),
        },
        browser: {},
        cleanup: jest.fn(async () => {}),
      }),
      createCheckpointRecorder: () => ({
        record: async (name) => ({
          name,
          url: 'https://chatgpt.com/',
          session: { hasAccessToken: name === 'final' },
          cookies: [],
        }),
      }),
      attachTraceSession: () => ({ detach: async () => {} }),
      runCatalogAnalysis,
      now: () => new Date('2026-03-15T19:00:02.000Z'),
      waitForEnter: async () => {},
    });

    expect(runCatalogAnalysis).toHaveBeenCalledTimes(1);
    expect(runCatalogAnalysis.mock.calls[0][1]).toEqual({ dryRun: false });
  });
});
