import { describe, expect, test } from '@jest/globals';

import { createCriticalAuthTracker, isCriticalAuthUrl } from '../../../src/pipeline/authTrace/cdpLive/criticalAuthTracker.js';

describe('isCriticalAuthUrl', () => {
  test('matches login_with and auth callback endpoints', () => {
    expect(isCriticalAuthUrl('https://chatgpt.com/auth/login_with')).toBe(true);
    expect(isCriticalAuthUrl('https://chatgpt.com/api/auth/callback/openai')).toBe(true);
    expect(isCriticalAuthUrl('https://example.com/')).toBe(false);
  });
});

describe('createCriticalAuthTracker', () => {
  test('captures critical request details including status and body', async () => {
    const records = [];
    const tracker = createCriticalAuthTracker({
      writeCriticalRecord: async (record) => records.push(record),
      getResponseBody: async (requestId) => ({ body: `{\"requestId\":\"${requestId}\"}`, base64Encoded: false }),
      now: () => new Date('2026-03-16T19:00:00.000Z'),
    });

    await tracker.onEvent('Network.requestWillBeSent', {
      requestId: '1',
      documentURL: 'https://chatgpt.com/auth/login_with',
      request: { url: 'https://chatgpt.com/auth/login_with', method: 'GET', headers: { accept: 'text/html' } },
      initiator: { type: 'other' },
    });
    await tracker.onEvent('Network.responseReceived', {
      requestId: '1',
      response: { url: 'https://chatgpt.com/auth/login_with', status: 200, mimeType: 'text/html', headers: { server: 'cloudflare' } },
    });
    await tracker.onEvent('Network.loadingFinished', { requestId: '1' });

    expect(records).toHaveLength(1);
    expect(records[0].url).toBe('https://chatgpt.com/auth/login_with');
    expect(records[0].status).toBe(200);
    expect(records[0].responseBody.text).toContain('requestId');
  });

  test('records challenge and js exception signals', async () => {
    const tracker = createCriticalAuthTracker({
      writeCriticalRecord: async () => {},
      getResponseBody: async () => ({ body: '', base64Encoded: false }),
      now: () => new Date('2026-03-16T19:00:00.000Z'),
    });

    await tracker.onEvent('Network.requestWillBeSent', {
      requestId: '2',
      documentURL: 'https://chatgpt.com/auth/login_with',
      request: { url: 'https://chatgpt.com/cdn-cgi/challenge-platform/scripts/jsd/main.js', method: 'GET', headers: {} },
      initiator: { type: 'script' },
    });
    await tracker.onEvent('Runtime.exceptionThrown', {
      exceptionDetails: { text: 'boom', exception: { description: 'TypeError: boom' } },
    });

    const summary = tracker.summary();
    expect(summary.challengeSignals).toHaveLength(1);
    expect(summary.jsExceptions).toHaveLength(1);
  });
});
