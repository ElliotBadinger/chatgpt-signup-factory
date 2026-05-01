import { describe, expect, test } from '@jest/globals';

import { createOpenAiSentinelProvider } from '../../../src/pipeline/authTrace/openaiSentinelProvider.js';

describe('createOpenAiSentinelProvider', () => {
  test('builds downstream sentinel headers by injecting the live sentinel response token into trace-derived templates', async () => {
    const requests = [];
    const provider = createOpenAiSentinelProvider({
      sentinel: {
        requestTemplates: {
          username_password_create: {
            method: 'POST',
            url: 'https://sentinel.openai.com/backend-api/sentinel/req',
            headers: {
              referer: 'https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=20260219f9f6',
              'user-agent': 'Mozilla/5.0 Test',
              'accept-language': 'en-US,en',
              'content-type': 'text/plain;charset=UTF-8',
            },
            body: {
              p: 'payload-register',
              id: 'device-123',
              flow: 'username_password_create',
            },
          },
        },
        headerTemplates: {
          '/api/accounts/user/register': {
            'openai-sentinel-token': {
              p: 'header-payload-register',
              t: 'header-proof-register',
              c: 'stale-token',
              id: 'device-123',
              flow: 'username_password_create',
            },
          },
          '/api/accounts/create_account': {
            'openai-sentinel-token': {
              p: 'header-payload-create',
              t: 'header-proof-create',
              c: 'stale-token',
              id: 'device-123',
              flow: 'oauth_create_account',
            },
            'openai-sentinel-so-token': {
              so: 'so-token',
              c: 'stale-token',
              id: 'device-123',
              flow: 'oauth_create_account',
            },
          },
        },
      },
      fetchImpl: async (url, options = {}) => {
        requests.push({ url, options });
        expect(url).toBe('https://sentinel.openai.com/backend-api/sentinel/req');
        expect(options.method).toBe('POST');
        expect(options.headers['content-type']).toBe('text/plain;charset=UTF-8');
        expect(options.body).toBe(JSON.stringify({
          p: 'payload-register',
          id: 'device-123',
          flow: 'username_password_create',
        }));
        return {
          status: 200,
          headers: new Headers({
            'content-type': 'application/json',
            'openai-processing-ms': '812',
            'openai-version': '2020-10-01',
            'x-oai-request-id': 'oai-req-123',
          }),
          text: async () => JSON.stringify({
            persona: 'chatgpt-noauth',
            token: 'live-sentinel-token',
            expire_after: 120,
            expire_at: 1773692720,
            turnstile: {},
            proofofwork: {},
          }),
        };
      },
      now: () => new Date('2026-03-16T21:00:00.000Z'),
    });

    const result = await provider.buildHeadersForPath('/api/accounts/user/register');

    expect(requests).toHaveLength(1);
    expect(result.flow).toBe('username_password_create');
    expect(result.step.name).toBe('sentinel_req_username_password_create');
    expect(result.step.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.step.responseHeaders['openai-processing-ms']).toBe('812');
    expect(result.step.responseHeaders['openai-version']).toBe('2020-10-01');
    expect(result.step.responseHeaders['x-oai-request-id']).toBe('oai-req-123');
    expect(result.responseJson.token).toBe('live-sentinel-token');
    expect(JSON.parse(result.headers['openai-sentinel-token'])).toEqual({
      p: 'header-payload-register',
      t: 'header-proof-register',
      c: 'live-sentinel-token',
      id: 'device-123',
      flow: 'username_password_create',
    });
  });
});
