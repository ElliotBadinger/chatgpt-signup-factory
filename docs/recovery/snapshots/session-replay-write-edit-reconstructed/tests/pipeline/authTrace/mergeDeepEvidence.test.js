import { describe, expect, test } from '@jest/globals';

import { buildRedirectChains, buildCookieChronology, mergeDeepEvidence } from '../../../src/pipeline/authTrace/deepCapture/mergeDeepEvidence.js';

describe('mergeDeepEvidence', () => {
  test('buildRedirectChains links redirect responses with locations', () => {
    const chains = buildRedirectChains([
      { url: 'https://auth.openai.com/a', responseStatus: 302, redirectLocation: 'https://auth.openai.com/b' },
      { url: 'https://auth.openai.com/b', responseStatus: 200, redirectLocation: null },
    ]);
    expect(chains).toEqual([{ from: 'https://auth.openai.com/a', to: 'https://auth.openai.com/b', status: 302 }]);
  });

  test('buildCookieChronology emits ordered cookie mutations', () => {
    const chronology = buildCookieChronology([
      { ts: 2, url: 'https://chatgpt.com/', setCookieNames: ['a'] },
      { ts: 1, url: 'https://auth.openai.com/', setCookieNames: ['b'] },
    ]);
    expect(chronology.map((e) => e.cookie)).toEqual(['b', 'a']);
  });

  test('mergeDeepEvidence combines proxy and cdp events', () => {
    const merged = mergeDeepEvidence({ proxyFlows: [{ id: 1 }], cdpEvents: [{ id: 'c1' }], browserTrace: [{ id: 'b1' }] });
    expect(merged.proxyFlows).toHaveLength(1);
    expect(merged.cdpEvents).toHaveLength(1);
    expect(merged.browserTrace).toHaveLength(1);
  });
});
