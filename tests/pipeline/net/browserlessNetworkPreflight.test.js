import { jest } from '@jest/globals';

import { assertBrowserlessNetwork, checkBrowserlessNetwork } from '../../../src/pipeline/net/browserlessNetworkPreflight.js';

describe('browserless network preflight', () => {
  test('reports DNS and fetch failures without hiding root cause', async () => {
    const result = await checkBrowserlessNetwork({
      hosts: ['chatgpt.com'],
      urls: ['https://chatgpt.com/'],
      fetchAttempts: 1,
      fetchImpl: async () => {
        throw Object.assign(new Error('fetch failed'), {
          cause: { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'chatgpt.com' },
        });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.dns).toHaveLength(1);
    expect(result.fetch[0].error.code).toBe('ENOTFOUND');
    expect(() => assertBrowserlessNetwork(result)).toThrow(/Browserless network preflight failed/);
  });

  test('retries transient fetch failures before failing preflight', async () => {
    const fetchImpl = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))
      .mockResolvedValueOnce({ status: 403 });

    const result = await checkBrowserlessNetwork({
      hosts: [],
      urls: ['https://chatgpt.com/'],
      fetchImpl,
      fetchAttempts: 2,
      fetchTimeoutMs: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.fetch[0].attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
