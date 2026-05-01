import { describe, expect, test } from '@jest/globals';
import { classifyEndpoint, buildReplayCandidates } from '../../../src/pipeline/authTrace/replayCandidates.js';

describe('classifyEndpoint', () => {
  test('Cloudflare CDN challenge platform is browser-bound', () => {
    expect(classifyEndpoint({ method: 'GET', url: 'https://auth.openai.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js', requestHeaders: {}, normalizedPath: '/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js', host: 'auth.openai.com' }))
      .toBe('browser-bound');
  });

  test('sentinel.openai.com SDK and req endpoints are browser-bound', () => {
    expect(classifyEndpoint({ method: 'POST', url: 'https://sentinel.openai.com/backend-api/sentinel/req', requestHeaders: {}, normalizedPath: '/backend-api/sentinel/req', host: 'sentinel.openai.com' }))
      .toBe('browser-bound');
    expect(classifyEndpoint({ method: 'GET', url: 'https://sentinel.openai.com/backend-api/sentinel/sdk.js', requestHeaders: {}, normalizedPath: '/backend-api/sentinel/sdk.js', host: 'sentinel.openai.com' }))
      .toBe('browser-bound');
  });

  test('email OTP validate is challenge-bound', () => {
    expect(classifyEndpoint({ method: 'POST', url: 'https://auth.openai.com/api/accounts/email-otp/validate', requestHeaders: {}, normalizedPath: '/api/accounts/email-otp/validate', host: 'auth.openai.com' }))
      .toBe('challenge-bound');
  });

  test('user/register with openai-sentinel-token header is replayable-with-dynamic-cookie-csrf-extraction', () => {
    expect(classifyEndpoint({ method: 'POST', url: 'https://auth.openai.com/api/accounts/user/register', requestHeaders: { 'openai-sentinel-token': '[REDACTED]' }, normalizedPath: '/api/accounts/user/register', host: 'auth.openai.com' }))
      .toBe('replayable-with-dynamic-cookie-csrf-extraction');
  });

  test('chatgpt.com/api/auth/session GET is replayable-direct', () => {
    expect(classifyEndpoint({ method: 'GET', url: 'https://chatgpt.com/api/auth/session', requestHeaders: {}, normalizedPath: '/api/auth/session', host: 'chatgpt.com' }))
      .toBe('replayable-direct');
  });

  test('chatgpt.com product endpoints are replayable-direct', () => {
    expect(classifyEndpoint({ method: 'GET', url: 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27', requestHeaders: {}, normalizedPath: '/backend-api/accounts/check/v4-2023-04-27', host: 'chatgpt.com' }))
      .toBe('replayable-direct');
  });

  test('auth.openai.com/api/accounts/authorize GET is browser-bound (OAuth kickoff)', () => {
    expect(classifyEndpoint({ method: 'GET', url: 'https://auth.openai.com/api/accounts/authorize', requestHeaders: {}, normalizedPath: '/api/accounts/authorize', host: 'auth.openai.com' }))
      .toBe('browser-bound');
  });
});

describe('buildReplayCandidates', () => {
  test('produces one entry per endpointId with classification and evidence', () => {
    const catalog = [
      { endpointId: 'GET:/api/auth/session', method: 'GET', url: 'https://chatgpt.com/api/auth/session', normalizedPath: '/api/auth/session', host: 'chatgpt.com', requestHeaders: {}, authCritical: true },
      { endpointId: 'POST:/backend-api/sentinel/req', method: 'POST', url: 'https://sentinel.openai.com/backend-api/sentinel/req', normalizedPath: '/backend-api/sentinel/req', host: 'sentinel.openai.com', requestHeaders: {}, authCritical: true },
    ];
    const candidates = buildReplayCandidates(catalog);
    expect(candidates).toHaveLength(2);
    const session = candidates.find((c) => c.endpointId === 'GET:/api/auth/session');
    expect(session.replayClassification).toBe('replayable-direct');
    const sentinel = candidates.find((c) => c.endpointId === 'POST:/backend-api/sentinel/req');
    expect(sentinel.replayClassification).toBe('browser-bound');
  });
});
