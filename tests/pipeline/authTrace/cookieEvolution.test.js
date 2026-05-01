import { describe, expect, test } from '@jest/globals';
import { buildCookieEvolution } from '../../../src/pipeline/authTrace/cookieEvolution.js';

const ORDERED_PHASES = ['landing', 'auth-page-loaded', 'post-callback', 'final'];

const DIFFS = {
  landing: {
    addedCookies: ['__Host-next-auth.csrf-token@chatgpt.com', '__Secure-next-auth.callback-url@chatgpt.com'],
    removedCookies: [],
    persistedCookies: [],
  },
  'auth-page-loaded': {
    addedCookies: ['login_session@.auth.openai.com', 'oai-login-csrf_dev@auth.openai.com'],
    removedCookies: ['__Host-next-auth.csrf-token@chatgpt.com'],
    persistedCookies: ['__Secure-next-auth.callback-url@chatgpt.com'],
  },
  'post-callback': {
    addedCookies: ['__Secure-next-auth.session-token@.chatgpt.com', 'oai-client-auth-info@chatgpt.com'],
    removedCookies: [],
    persistedCookies: ['__Secure-next-auth.callback-url@chatgpt.com', 'login_session@.auth.openai.com'],
  },
  final: {
    addedCookies: [],
    removedCookies: [],
    persistedCookies: ['__Secure-next-auth.session-token@.chatgpt.com', 'oai-client-auth-info@chatgpt.com'],
  },
};

describe('buildCookieEvolution', () => {
  test('produces one phase entry per checkpoint diff', () => {
    const evo = buildCookieEvolution(DIFFS, ORDERED_PHASES);
    expect(evo.phases).toHaveLength(4);
    expect(evo.phases[0].phase).toBe('landing');
  });

  test('firstAppearance maps cookie to the phase where it was first added', () => {
    const evo = buildCookieEvolution(DIFFS, ORDERED_PHASES);
    expect(evo.firstAppearance['__Secure-next-auth.session-token@.chatgpt.com']).toBe('post-callback');
    expect(evo.firstAppearance['login_session@.auth.openai.com']).toBe('auth-page-loaded');
  });

  test('authSideCookies contains auth.openai.com cookies', () => {
    const evo = buildCookieEvolution(DIFFS, ORDERED_PHASES);
    expect(evo.authSideCookies.some((c) => c.includes('auth.openai.com'))).toBe(true);
  });

  test('sessionCookies contains the next-auth session token', () => {
    const evo = buildCookieEvolution(DIFFS, ORDERED_PHASES);
    expect(evo.sessionCookies).toContain('__Secure-next-auth.session-token@.chatgpt.com');
  });

  test('phase with missing diffs is marked data-missing', () => {
    const evo = buildCookieEvolution({}, ORDERED_PHASES);
    expect(evo.phases[0].status).toBe('data-missing');
  });
});
