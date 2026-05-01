import { describe, expect, test } from '@jest/globals';
import { buildFlowSequence, flagAuthCritical } from '../../../src/pipeline/authTrace/flowSequence.js';

const AUTH_SIDE_PAIR = {
  id: 2,
  request: { ts: 2000, method: 'GET', url: 'https://auth.openai.com/api/accounts/authorize?client_id=abc', headers: {}, postData: null },
  response: { status: 302, headers: { location: 'https://auth.openai.com/create-account/password' }, body: null },
};

const PRE_TOKEN_SESSION_PAIR = {
  id: 1,
  request: { ts: 1000, method: 'GET', url: 'https://chatgpt.com/api/auth/session', headers: {}, postData: null },
  response: { status: 200, headers: {}, body: { kind: 'json', keys: ['WARNING_BANNER'], schema: null } },
};

const POST_TOKEN_SESSION_PAIR = {
  id: 54,
  request: { ts: 9000, method: 'GET', url: 'https://chatgpt.com/api/auth/session', headers: {}, postData: null },
  response: { status: 200, headers: {}, body: { kind: 'json', keys: ['WARNING_BANNER', 'user', 'accessToken'], schema: null } },
};

const PRODUCT_PAIR = {
  id: 30,
  request: { ts: 7000, method: 'GET', url: 'https://chatgpt.com/backend-api/gizmos/bootstrap?limit=2', headers: {}, postData: null },
  response: { status: 200, headers: {}, body: null },
};

describe('flagAuthCritical', () => {
  test('auth.openai.com endpoints are auth-critical', () => {
    expect(flagAuthCritical(AUTH_SIDE_PAIR)).toBe(true);
  });

  test('chatgpt.com/api/auth/session is auth-critical', () => {
    expect(flagAuthCritical(PRE_TOKEN_SESSION_PAIR)).toBe(true);
  });

  test('product bootstrap endpoints are not auth-critical', () => {
    expect(flagAuthCritical(PRODUCT_PAIR)).toBe(false);
  });
});

describe('buildFlowSequence', () => {
  const pairs = [PRE_TOKEN_SESSION_PAIR, AUTH_SIDE_PAIR, PRODUCT_PAIR, POST_TOKEN_SESSION_PAIR];

  test('entries are ordered by timestamp', () => {
    const seq = buildFlowSequence(pairs);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i].ts).toBeGreaterThanOrEqual(seq[i - 1].ts);
    }
  });

  test('marks firstAccessTokenOccurrence on the session response that first includes accessToken key', () => {
    const seq = buildFlowSequence(pairs);
    const tokenEntry = seq.find((e) => e.firstAccessTokenOccurrence);
    expect(tokenEntry).toBeDefined();
    expect(tokenEntry.id).toBe(54);
  });

  test('each entry has correct shape', () => {
    const seq = buildFlowSequence(pairs);
    const entry = seq[0];
    expect(entry).toMatchObject({
      id: expect.any(Number),
      ts: expect.any(Number),
      method: expect.any(String),
      url: expect.any(String),
      normalizedPath: expect.any(String),
      host: expect.any(String),
      responseStatus: expect.anything(),
      authCritical: expect.any(Boolean),
    });
  });
});
