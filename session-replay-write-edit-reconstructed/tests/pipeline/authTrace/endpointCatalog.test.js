import { describe, expect, test } from '@jest/globals';
import { normalizePath, buildEndpointCatalog } from '../../../src/pipeline/authTrace/endpointCatalog.js';

describe('normalizePath', () => {
  test('strips UUIDs to :uuid', () => {
    expect(normalizePath('/api/accounts/037bf0ab-6988-4f13-b7f4-802e2f3e0143/info'))
      .toBe('/api/accounts/:uuid/info');
  });

  test('strips hex-segment IDs like challenge-platform paths', () => {
    expect(normalizePath('/cdn-cgi/challenge-platform/h/g/scripts/jsd/ea2d291c0fdc/main.js'))
      .toBe('/cdn-cgi/challenge-platform/h/g/scripts/jsd/:hexid/main.js');
  });

  test('preserves known API paths intact', () => {
    expect(normalizePath('/api/auth/session')).toBe('/api/auth/session');
    expect(normalizePath('/backend-api/accounts/check/v4-2023-04-27')).toBe('/backend-api/accounts/check/v4-2023-04-27');
  });
});

describe('buildEndpointCatalog', () => {
  const pairs = [
    {
      id: 1,
      request: { ts: 1000, method: 'GET', url: 'https://chatgpt.com/api/auth/session', headers: { 'user-agent': 'UA' }, postData: null },
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: { kind: 'json', keys: ['WARNING_BANNER'], schema: { type: 'object', keys: { WARNING_BANNER: 'string' } } } },
    },
    {
      id: 54,
      request: { ts: 5000, method: 'GET', url: 'https://chatgpt.com/api/auth/session', headers: { 'user-agent': 'UA' }, postData: null },
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: { kind: 'json', keys: ['WARNING_BANNER', 'user', 'accessToken'], schema: { type: 'object', keys: { WARNING_BANNER: 'string', user: 'object', accessToken: 'string' } } } },
    },
  ];

  test('deduplicates same method+path into one entry', () => {
    const catalog = buildEndpointCatalog(pairs);
    const entry = catalog.find((e) => e.endpointId === 'GET:/api/auth/session');
    expect(entry).toBeDefined();
    expect(entry.occurrences).toBe(2);
  });

  test('records first and last ts', () => {
    const catalog = buildEndpointCatalog(pairs);
    const entry = catalog.find((e) => e.endpointId === 'GET:/api/auth/session');
    expect(entry.firstTs).toBe(1000);
    expect(entry.lastTs).toBe(5000);
  });

  test('records host and normalizedPath correctly', () => {
    const catalog = buildEndpointCatalog(pairs);
    const entry = catalog.find((e) => e.endpointId === 'GET:/api/auth/session');
    expect(entry.host).toBe('chatgpt.com');
    expect(entry.normalizedPath).toBe('/api/auth/session');
  });

  test('captures query param keys from url', () => {
    const pairsWithQuery = [
      {
        id: 1,
        request: { ts: 1, method: 'GET', url: 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=420', headers: {}, postData: null },
        response: { status: 200, headers: {}, body: null },
      },
    ];
    const catalog = buildEndpointCatalog(pairsWithQuery);
    const entry = catalog[0];
    expect(entry.queryParamKeys).toContain('timezone_offset_min');
  });

  test('entry with no response gets responseStatus null', () => {
    const pairsNoRes = [
      { id: 1, request: { ts: 1, method: 'GET', url: 'https://chatgpt.com/api/auth/session', headers: {}, postData: null }, response: null },
    ];
    const catalog = buildEndpointCatalog(pairsNoRes);
    expect(catalog[0].responseStatus).toBeNull();
  });

  test('merges richer response schema from later occurrence', () => {
    const catalog = buildEndpointCatalog(pairs);
    const entry = catalog.find((e) => e.endpointId === 'GET:/api/auth/session');
    expect(entry.responseBodyKeys).toContain('accessToken');
  });
});
