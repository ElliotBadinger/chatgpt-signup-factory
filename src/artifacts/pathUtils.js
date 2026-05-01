import path from 'node:path';

/**
 * Prefix a relative artifact file path with a run artifact directory.
 *
 * - If artifactDir is null/undefined/empty -> returns filePath unchanged
 * - If filePath is absolute -> returns filePath unchanged (caller opted into absolute)
 * - If filePath is already under artifactDir -> returns filePath unchanged
 */
export function resolveArtifactPath(artifactDir, filePath) {
  if (!artifactDir || !filePath) return filePath;
  if (path.isAbsolute(filePath)) return filePath;

  const normDir = path.normalize(artifactDir);
  const normFile = path.normalize(filePath);

  if (normFile === normDir || normFile.startsWith(normDir + path.sep)) {
    return filePath;
  }

  // First, normalize to remove any weirdness
  const safeFile = filePath.replace(/\.\./g, '__');
  const joined = path.join(artifactDir, safeFile);

  return joined;
}
