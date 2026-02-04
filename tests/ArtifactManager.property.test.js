import fc from 'fast-check';
import path from 'path';
import { resolveArtifactPath } from '../src/artifacts/pathUtils.js';

describe('ArtifactManager Property Tests', () => {
  const baseDir = 'artifacts/run1';

  test('resolveArtifactPath should never return a path with ".." for relative inputs', () => {
    fc.assert(
      fc.property(fc.string(), (p) => {
        if (!p || path.isAbsolute(p)) return true;
        const res = resolveArtifactPath(baseDir, p);
        expect(res.includes('..')).toBe(false);
      }),
      { seed: 42, numRuns: 1000 }
    );
  });

  test('resolveArtifactPath should never escape artifactDir for relative inputs', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.string(), fc.constant('..'))), (parts) => {
        const filePath = parts.join('/');
        if (path.isAbsolute(filePath) || !filePath) return true;

        const resolved = resolveArtifactPath(baseDir, filePath);
        
        const absoluteBase = path.resolve(baseDir);
        const absoluteResolved = path.resolve(resolved);

        // resolved should be under baseDir
        return absoluteResolved.startsWith(absoluteBase);
      }),
      { seed: 42, numRuns: 1000 }
    );
  });

  test('resolveArtifactPath should be idempotent under repeated application', () => {
    fc.assert(
      fc.property(fc.string(), (filePath) => {
        const first = resolveArtifactPath(baseDir, filePath);
        const second = resolveArtifactPath(baseDir, first);
        expect(second).toEqual(first);
      }),
      { seed: 42, numRuns: 1000 }
    );
  });
});
