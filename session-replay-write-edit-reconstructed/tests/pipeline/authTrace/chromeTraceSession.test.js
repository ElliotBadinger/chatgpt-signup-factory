import { describe, expect, jest, test } from '@jest/globals';

import { attachChromeTraceSession, isRelevantTraceUrl } from '../../../src/pipeline/authTrace/chromeTraceSession.js';

describe('isRelevantTraceUrl', () => {
  test('filters openai, chatgpt, clerk and cloudflare challenge urls', () => {
    expect(isRelevantTraceUrl('https://chatgpt.com/')).toBe(true);
    expect(isRelevantTraceUrl('https://auth.openai.com/')).toBe(true);
    expect(isRelevantTraceUrl('https://clerk.accounts.dev/foo')).toBe(true);
    expect(isRelevantTraceUrl('https://challenges.cloudflare.com/turnstile/v0/api.js')).toBe(true);
    expect(isRelevantTraceUrl('https://example.com/')).toBe(false);
  });
});

describe('attachChromeTraceSession', () => {
  test('attaches listeners and writes redacted request/response/nav events', async () => {
    const listeners = new Map();
    const page = {
      on: jest.fn((event, fn) => listeners.set(event, fn)),
    };
    const writes = [];
    const writer = { write: jest.fn(async (event) => writes.push(event)) };

    attachChromeTraceSession({ page, writer });

    await listeners.get('request')({
      url: () => 'https://auth.openai.com/u/signin',
      method: () => 'POST',
      headers: () => ({ Authorization: 'Bearer secret' }),
      postData: () => '{"email":"x@example.com"}',
    });
    await listeners.get('response')({
      url: () => 'https://chatgpt.com/api/auth/session',
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ accessToken: 'secret', user: { id: 'u1' } }),
    });
    await listeners.get('framenavigated')({ url: () => 'https://chatgpt.com/' });

    expect(page.on).toHaveBeenCalled();
    expect(writes[0]).toMatchObject({ type: 'request', method: 'POST', headers: { Authorization: '[REDACTED]' } });
    expect(writes[1]).toMatchObject({
      type: 'response',
      status: 200,
      body: expect.objectContaining({ kind: 'json', keys: ['accessToken', 'user'] }),
    });
    expect(writes[2]).toMatchObject({ type: 'nav', url: 'https://chatgpt.com/' });
  });
});
