import path from 'node:path';

/**
 * Prefix a relative artifact file path with a run artifact directory.
 *
 * - If artifactDir is null/undefined/empty -> returns filePath unchanged
 * - If filePath is absolute -> returns filePath unchanged (caller opted into absolute)
 * - If filePath is already under artifactDir -> returns filePath unchanged
 */
export function resolveArtifactPath(artifactDir, filePath) {
  if (!artifactDir) return filePath;
  if (!filePath) return filePath;

  if (path.isAbsolute(filePath)) return filePath;

  const normDir = path.normalize(artifactDir);
  const normFile = path.normalize(filePath);

  if (normFile === normDir || normFile.startsWith(normDir + path.sep)) {
    return filePath;
  }

  const joined = path.join(artifactDir, filePath);
  // Ensure we don't return anything with ..
  return joined.replace(/\.\./g, '__'); 
}
