import { describe, expect, test } from '@jest/globals';
import { loadTracePairs, loadCookieDiffs, loadCheckpoints } from '../../../src/pipeline/authTrace/traceArtifactLoader.js';
import path from 'node:path';

const FIXTURE_DIR = path.resolve('artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2');

describe('loadTracePairs', () => {
  test('loads all request/response pairs ordered by numeric id', async () => {
    const pairs = await loadTracePairs(FIXTURE_DIR);
    expect(pairs.length).toBeGreaterThan(50);
    // sorted by id
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i].id).toBeGreaterThan(pairs[i - 1].id);
    }
    // pair shape
    const first = pairs[0];
    expect(first.id).toBe(1);
    expect(first.request.method).toBe('GET');
    expect(first.request.url).toContain('chatgpt.com/api/auth/session');
    expect(first.response.status).toBe(200);
  });

  test('pairs request and response by url/timestamp order when file ids drift', async () => {
    const pairs = await loadTracePairs(FIXTURE_DIR);
    const pricingPair = pairs.find((pair) => pair.id === 53);
    expect(pricingPair.request.url).toBe('https://chatgpt.com/backend-api/checkout_pricing_config/configs/ZA');
    expect(pricingPair.response.url).toBe('https://chatgpt.com/backend-api/checkout_pricing_config/configs/ZA');
  });

  test('pair with no matching response gets response null', async () => {
    const pairs = await loadTracePairs(FIXTURE_DIR, {
      overrideRequests: [{ type: 'request', ts: 100, url: 'https://example.com/x', method: 'GET', headers: {}, postData: null }],
      overrideResponses: [],
    });
    expect(pairs[0].response).toBeNull();
  });
});

describe('loadCookieDiffs', () => {
  test('loads all cookie-diff files keyed by checkpoint name', async () => {
    const diffs = await loadCookieDiffs(FIXTURE_DIR);
    expect(typeof diffs).toBe('object');
    expect(diffs['auth-page-loaded']).toBeDefined();
    expect(Array.isArray(diffs['auth-page-loaded'].addedCookies)).toBe(true);
  });
});

describe('loadCheckpoints', () => {
  test('loads all checkpoints ordered by ts', async () => {
    const cps = await loadCheckpoints(FIXTURE_DIR);
    expect(cps.length).toBeGreaterThan(0);
    expect(cps[0].name).toBeDefined();
    expect(cps[0].url).toBeDefined();
  });
});
