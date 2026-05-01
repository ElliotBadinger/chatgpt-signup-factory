import { describe, expect, test } from '@jest/globals';

import { buildBootstrapAnalysis } from '../../../src/pipeline/authTrace/cdpLive/bootstrapAnalysis.js';

describe('buildBootstrapAnalysis', () => {
  test('summarizes login_with flow, follow-up failures, exceptions, and challenges', () => {
    const analysis = buildBootstrapAnalysis({
      criticalRequests: [
        { url: 'https://chatgpt.com/api/auth/callback/openai?x=1', status: 302, responseHeaders: { location: 'https://chatgpt.com/auth/login_with' } },
        { url: 'https://chatgpt.com/auth/login_with', status: 200, responseBody: { text: '<html>loading</html>' } },
        { url: 'https://chatgpt.com/backend-api/user_granular_consent', status: 500, responseBody: { text: '{"error":"bad"}' } },
        { url: 'https://chatgpt.com/api/auth/signin/openai?prompt=login', status: 302 },
      ],
      jsExceptions: [{ text: 'TypeError: boom' }],
      challengeSignals: [{ kind: 'cloudflare-challenge-script', url: 'https://chatgpt.com/cdn-cgi/challenge-platform/scripts/jsd/main.js' }],
    });

    expect(analysis.loginWith.url).toContain('/auth/login_with');
    expect(analysis.followUpFailures[0].status).toBe(500);
    expect(analysis.jsExceptions[0].text).toContain('boom');
    expect(analysis.challengeSignals[0].kind).toContain('challenge');
    expect(analysis.likelyFailurePoint).toMatch(/login_with|bootstrap|challenge/i);
  });
});
