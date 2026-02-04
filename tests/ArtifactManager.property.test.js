import { jest } from '@jest/globals';
import fc from 'fast-check';
import { resolveArtifactPath } from '../src/artifacts/pathUtils.js';

describe('ArtifactManager Property Tests', () => {
  test('resolveArtifactPath should never return a path with ".." when given a base dir', () => {
    fc.assert(
      fc.property(fc.string(), (p) => {
        const res = resolveArtifactPath('artifacts/run', p);
        expect(res.includes('..')).toBe(false);
      }),
      { seed: 42, numRuns: 1000 }
    );
  });
});
