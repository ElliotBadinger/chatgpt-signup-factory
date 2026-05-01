import { describe, expect, test } from '@jest/globals';

import {
  buildCatalogAnalysis,
  classifyReplayability,
  inferActualScenario,
  summarizeCheckpointDiff,
} from '../../../src/pipeline/authTrace/analysis.js';

describe('inferActualScenario', () => {
  test('infers signin-existing from auth password page and authenticated callback', () => {
    const checkpoints = [
      { name: 'auth-page-loaded', url: 'https://auth.openai.com/log-in/password', session: { hasAccessToken: false } },
      { name: 'post-callback', url: 'https://chatgpt.com/', session: { hasAccessToken: true } },
    ];
    expect(inferActualScenario(checkpoints)).toBe('signin-existing');
  });
});

describe('summarizeCheckpointDiff', () => {
  test('computes added and removed cookies', () => {
    const prev = { cookies: [{ name: 'a', domain: 'x' }, { name: 'b', domain: 'x' }] };
    const next = { cookies: [{ name: 'b', domain: 'x' }, { name: 'c', domain: 'y' }] };
    expect(summarizeCheckpointDiff(prev, next)).toEqual({
      addedCookies: ['c@y'],
      removedCookies: ['a@x'],
      persistedCookies: ['b@x'],
    });
  });
});

describe('classifyReplayability', () => {
  test('classifies browser-bootstrap-only when callback succeeds but auth-side request chain is incomplete', () => {
    expect(classifyReplayability({
      actualScenario: 'signin-existing',
      hasAuthenticatedSession: true,
      sawAuthOpenAi: true,
      sawChatGptSession: true,
      sawPasswordPage: true,
      sawSignupPage: false,
    })).toEqual({
      classification: 'browser-bootstrap-only',
      confidence: 'medium',
    });
  });
});

describe('buildCatalogAnalysis', () => {
  const flowSeq = [
    { id: 1, ts: 1000, method: 'GET', url: 'https://chatgpt.com/api/auth/session', normalizedPath: '/api/auth/session', host: 'chatgpt.com', authCritical: true, firstAccessTokenOccurrence: false, responseStatus: 200, responseBodyKeys: ['WARNING_BANNER'] },
    { id: 2, ts: 2000, method: 'GET', url: 'https://auth.openai.com/api/accounts/authorize', normalizedPath: '/api/accounts/authorize', host: 'auth.openai.com', authCritical: true, firstAccessTokenOccurrence: false, responseStatus: 302, responseBodyKeys: null },
    { id: 54, ts: 9000, method: 'GET', url: 'https://chatgpt.com/api/auth/session', normalizedPath: '/api/auth/session', host: 'chatgpt.com', authCritical: true, firstAccessTokenOccurrence: true, responseStatus: 200, responseBodyKeys: ['WARNING_BANNER', 'user', 'accessToken'] },
  ];

  const candidates = [
    { endpointId: 'GET:/api/auth/session', replayClassification: 'replayable-direct', authCritical: true },
    { endpointId: 'GET:/api/accounts/authorize', replayClassification: 'browser-bound', authCritical: true },
  ];

  const cookieEvo = {
    firstAppearance: {
      'login_session@.auth.openai.com': 'auth-page-loaded',
      '__Secure-next-auth.session-token@.chatgpt.com': 'post-callback',
    },
    authSideCookies: ['login_session@.auth.openai.com'],
    chatgptSideCookies: ['__Secure-next-auth.session-token@.chatgpt.com'],
    sessionCookies: ['__Secure-next-auth.session-token@.chatgpt.com'],
  };

  test('firstAuthSideSessionRequest identifies first auth.openai.com request', () => {
    const analysis = buildCatalogAnalysis({ flowSeq, candidates, cookieEvo });
    expect(analysis.firstAuthSideSessionRequest.id).toBe(2);
  });

  test('firstAccessTokenRequest identifies first session response with accessToken', () => {
    const analysis = buildCatalogAnalysis({ flowSeq, candidates, cookieEvo });
    expect(analysis.firstAccessTokenRequest.id).toBe(54);
  });

  test('preCallbackCookies are cookies first appearing before post-callback', () => {
    const analysis = buildCatalogAnalysis({ flowSeq, candidates, cookieEvo });
    expect(analysis.preCallbackCookies).toContain('login_session@.auth.openai.com');
    expect(analysis.preCallbackCookies).not.toContain('__Secure-next-auth.session-token@.chatgpt.com');
  });

  test('postCallbackCookies are cookies first appearing at or after post-callback', () => {
    const analysis = buildCatalogAnalysis({ flowSeq, candidates, cookieEvo });
    expect(analysis.postCallbackCookies).toContain('__Secure-next-auth.session-token@.chatgpt.com');
  });

  test('browserBoundEndpoints lists browser-bound endpoint ids', () => {
    const analysis = buildCatalogAnalysis({ flowSeq, candidates, cookieEvo });
    expect(analysis.browserBoundEndpoints).toContain('GET:/api/accounts/authorize');
  });

  test('likelyReplayCandidates lists replayable-direct endpoint ids', () => {
    const analysis = buildCatalogAnalysis({ flowSeq, candidates, cookieEvo });
    expect(analysis.likelyReplayCandidates).toContain('GET:/api/auth/session');
  });
});
