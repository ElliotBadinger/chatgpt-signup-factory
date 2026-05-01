import { describe, expect, test } from '@jest/globals';

import {
  detectChallengeMarkers,
  normalizeCheckpoint,
  summarizeClerkProbe,
  summarizeSessionPayload,
} from '../../../src/pipeline/authTrace/checkpoints.js';

describe('summarizeClerkProbe', () => {
  test('extracts stable Clerk summary fields', () => {
    expect(summarizeClerkProbe({ loaded: true, hasClient: true, signUpStatus: 'missing_requirements', signInStatus: null, sessionId: 'sess_123' })).toEqual({
      loaded: true,
      hasClient: true,
      signUpStatus: 'missing_requirements',
      signInStatus: null,
      sessionId: 'sess_123',
    });
  });
});

describe('summarizeSessionPayload', () => {
  test('reduces chatgpt session payload to stable summary', () => {
    expect(summarizeSessionPayload({ accessToken: 'abc', refreshToken: 'def', user: { id: 'u1' }, expires: '2026-01-01T00:00:00.000Z' })).toEqual({
      hasAccessToken: true,
      hasRefreshToken: true,
      userId: 'u1',
      expires: '2026-01-01T00:00:00.000Z',
      keys: ['accessToken', 'refreshToken', 'user', 'expires'],
    });
  });
});

describe('detectChallengeMarkers', () => {
  test('detects turnstile/cloudflare markers from page summary', () => {
    expect(detectChallengeMarkers({ bodyText: 'Just a moment... verify you are human', hasTurnstileIframe: true })).toEqual({
      hasCloudflareText: true,
      hasTurnstileIframe: true,
      hasCaptchaContainer: false,
    });
  });
});

describe('normalizeCheckpoint', () => {
  test('returns normalized checkpoint object', () => {
    const cp = normalizeCheckpoint('password-page', {
      url: 'https://auth.openai.com/create-account/password',
      title: 'OpenAI',
      clerk: { loaded: true },
      session: { WARNING_BANNER: true },
      page: { bodyText: 'Create account' },
      cookies: [{ name: '__cf_bm', domain: '.openai.com' }],
    });

    expect(cp.name).toBe('password-page');
    expect(cp.url).toBe('https://auth.openai.com/create-account/password');
    expect(cp.clerk.loaded).toBe(true);
    expect(cp.session.hasAccessToken).toBe(false);
    expect(cp.cookies).toEqual([{ name: '__cf_bm', domain: '.openai.com' }]);
  });
});
