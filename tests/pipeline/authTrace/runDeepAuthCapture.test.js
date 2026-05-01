import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

import { runDeepAuthCapture } from '../../../src/pipeline/authTrace/deepCapture/runDeepAuthCapture.js';

describe('runDeepAuthCapture', () => {
  test('orchestrates proxy, browser, cdp, checkpoints, and analyzer', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'deep-auth-capture-'));
    const launchMitmproxy = jest.fn(async () => ({ port: 8899, cleanup: async () => {} }));
    const launchLocalChrome = jest.fn(async () => ({
      page: { goto: jest.fn(async () => {}), target: () => ({ createCDPSession: async () => ({ send: async () => {}, on: () => {}, detach: async () => {} }) }) },
      cleanup: async () => {},
    }));
    const attachTraceSession = jest.fn(() => ({ detach: async () => {} }));
    const attachCdpNetwork = jest.fn(async () => ({ detach: async () => {} }));
    const checkpoint = jest.fn(async (name) => ({ name, url: name === 'auth-page-loaded' ? 'https://auth.openai.com/create-account/password' : 'https://chatgpt.com/', session: { hasAccessToken: name === 'final' }, cookies: [] }));
    const runCatalogAnalysis = jest.fn(async () => ({}));

    const result = await runDeepAuthCapture({ artifactDir, label: 'deep-test', scenario: 'signup-new' }, {
      launchMitmproxy,
      launchLocalChrome,
      attachTraceSession,
      attachCdpNetwork,
      createCheckpointRecorder: () => ({ record: checkpoint }),
      runCatalogAnalysis,
      waitForEnter: async () => {},
      now: () => new Date('2026-03-15T22:00:00.000Z'),
      readJsonLines: async () => [],
    });

    expect(launchMitmproxy).toHaveBeenCalled();
    expect(launchLocalChrome).toHaveBeenCalledWith(expect.objectContaining({ proxyServer: '127.0.0.1:8899' }), expect.any(Object));
    expect(attachTraceSession).toHaveBeenCalled();
    expect(attachCdpNetwork).toHaveBeenCalled();
    expect(runCatalogAnalysis).toHaveBeenCalledWith(result.runDir, { dryRun: false });

    const summary = JSON.parse(await readFile(path.join(result.runDir, 'summary.json'), 'utf8'));
    expect(summary.label).toBe('deep-test');
    expect(summary.captureMode).toBe('deep-manual');
    expect(summary).toHaveProperty('certificateTrust');
  });

  test('does not auto-enable certutil trust path when certutilBin is omitted', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'deep-auth-capture-'));
    const launchMitmproxy = jest.fn(async () => ({ port: 8899, cleanup: async () => {} }));
    const launchLocalChrome = jest.fn(async () => ({
      page: { goto: jest.fn(async () => {}), target: () => ({ createCDPSession: async () => ({ send: async () => {}, on: () => {}, detach: async () => {} }) }) },
      cleanup: async () => {},
    }));

    const result = await runDeepAuthCapture({ artifactDir, label: 'deep-no-certutil', scenario: 'signup-new' }, {
      launchMitmproxy,
      launchLocalChrome,
      attachTraceSession: () => ({ detach: async () => {} }),
      attachCdpNetwork: async () => ({ detach: async () => {} }),
      createCheckpointRecorder: () => ({ record: async (name) => ({ name, url: 'https://chatgpt.com/', session: { hasAccessToken: name === 'final' }, cookies: [] }) }),
      runCatalogAnalysis: async () => ({}),
      waitForEnter: async () => {},
      now: () => new Date('2026-03-15T22:10:00.000Z'),
      readJsonLines: async () => [],
    });

    const summary = JSON.parse(await readFile(path.join(result.runDir, 'summary.json'), 'utf8'));
    expect(summary.certificateTrust).toEqual({ ok: false, reason: 'disabled' });
    expect(launchLocalChrome.mock.calls[0][0].env?.HOME).toBeUndefined();
  });

  test('attaches to an existing browser when browserUrl is provided', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'deep-auth-capture-'));
    const launchMitmproxy = jest.fn(async () => ({ port: 8899, cleanup: async () => {} }));
    const connectToBrowser = jest.fn(async () => ({
      page: { goto: jest.fn(async () => {}), target: () => ({ createCDPSession: async () => ({ send: async () => {}, on: () => {}, detach: async () => {} }) }) },
      cleanup: async () => {},
    }));
    const launchLocalChrome = jest.fn();

    await runDeepAuthCapture({ artifactDir, label: 'deep-attach', scenario: 'signup-new', browserUrl: 'http://127.0.0.1:9223' }, {
      launchMitmproxy,
      connectToBrowser,
      launchLocalChrome,
      attachTraceSession: () => ({ detach: async () => {} }),
      attachCdpNetwork: async () => ({ detach: async () => {} }),
      createCheckpointRecorder: () => ({ record: async (name) => ({ name, url: 'https://chatgpt.com/', session: { hasAccessToken: name === 'final' }, cookies: [] }) }),
      runCatalogAnalysis: async () => ({}),
      waitForEnter: async () => {},
      now: () => new Date('2026-03-15T22:12:00.000Z'),
      readJsonLines: async () => [],
    });

    expect(connectToBrowser).toHaveBeenCalledWith({ browserUrl: 'http://127.0.0.1:9223' });
    expect(launchLocalChrome).not.toHaveBeenCalled();
  });
});
