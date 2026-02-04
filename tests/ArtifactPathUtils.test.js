import path from 'node:path';

import { resolveArtifactPath } from '../src/artifacts/pathUtils.js';

describe('resolveArtifactPath', () => {
  test('prefixes relative filePath with artifactDir', () => {
    expect(resolveArtifactPath('artifacts/run-1', 'step_1.png')).toBe(path.join('artifacts/run-1', 'step_1.png'));
  });

  test('does not double-prefix when filePath already includes artifactDir', () => {
    const p = path.join('artifacts/run-1', 'step_1.png');
    expect(resolveArtifactPath('artifacts/run-1', p)).toBe(p);
  });

  test('returns filePath as-is when artifactDir is not set', () => {
    expect(resolveArtifactPath(null, 'x.png')).toBe('x.png');
  });
});
