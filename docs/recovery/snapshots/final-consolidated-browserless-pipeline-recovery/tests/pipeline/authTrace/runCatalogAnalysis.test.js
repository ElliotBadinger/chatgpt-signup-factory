import { describe, expect, test } from '@jest/globals';
import path from 'node:path';
import { runCatalogAnalysis } from '../../../src/pipeline/authTrace/runCatalogAnalysis.js';

const FIXTURE_DIR = path.resolve('artifacts/auth-traces/2026-03-15T20-01-44-099Z-deep-golden-signup-v2');

describe('runCatalogAnalysis', () => {
  test('produces all five output artifact shapes from a real trace dir', async () => {
    const result = await runCatalogAnalysis(FIXTURE_DIR, { dryRun: true });
    expect(result.endpointCatalog).toBeInstanceOf(Array);
    expect(result.endpointCatalog.length).toBeGreaterThan(10);

    expect(result.flowSequence).toBeInstanceOf(Array);
    expect(result.flowSequence.length).toBeGreaterThan(10);

    expect(result.cookieEvolution).toHaveProperty('phases');
    expect(result.cookieEvolution).toHaveProperty('firstAppearance');

    expect(result.replayCandidates).toBeInstanceOf(Array);
    expect(result.replayCandidates.length).toBeGreaterThan(0);

    expect(result.analysis).toHaveProperty('firstAuthSideSessionRequest');
    expect(result.analysis).toHaveProperty('firstAccessTokenRequest');
    expect(result.analysis).toHaveProperty('browserBoundEndpoints');
    expect(result.analysis).toHaveProperty('likelyReplayCandidates');
  });

  test('firstAuthSideSessionRequest is auth.openai.com authorize endpoint host', async () => {
    const result = await runCatalogAnalysis(FIXTURE_DIR, { dryRun: true });
    expect(result.analysis.firstAuthSideSessionRequest?.host).toBe('auth.openai.com');
  });

  test('firstAccessTokenRequest is chatgpt.com/api/auth/session', async () => {
    const result = await runCatalogAnalysis(FIXTURE_DIR, { dryRun: true });
    expect(result.analysis.firstAccessTokenRequest?.url).toContain('/api/auth/session');
  });

  test('sentinel endpoints classified as browser-bound', async () => {
    const result = await runCatalogAnalysis(FIXTURE_DIR, { dryRun: true });
    const sentinelEntry = result.replayCandidates.find((c) => c.host === 'sentinel.openai.com');
    expect(sentinelEntry).toBeDefined();
    expect(sentinelEntry.replayClassification).toBe('browser-bound');
  });

  test('chatgpt.com product API endpoints classified as replayable-direct', async () => {
    const result = await runCatalogAnalysis(FIXTURE_DIR, { dryRun: true });
    const check = result.replayCandidates.find((c) => c.normalizedPath.startsWith('/backend-api/accounts/check'));
    expect(check).toBeDefined();
    expect(check.replayClassification).toBe('replayable-direct');
  });
});
