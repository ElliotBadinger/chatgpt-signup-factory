/**
 * Artifact directory and summary writing utilities.
 * Owns deterministic run-id-based artifact path creation and summary.json writing.
 * Pure file-writing logic — no browser/network behavior.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Returns the deterministic artifact directory path for a given run.
 *
 * @param {string} baseDir - Root directory for all run artifacts.
 * @param {string} runId   - Unique run identifier.
 * @returns {string}
 */
export function artifactDirPath(baseDir, runId) {
  return path.join(baseDir, runId);
}

/**
 * Ensures the artifact directory exists, creating it (and any parents) if needed.
 * Idempotent — safe to call on an existing directory.
 *
 * @param {string} artifactDir
 * @returns {Promise<void>}
 */
export async function ensureArtifactDir(artifactDir) {
  await mkdir(artifactDir, { recursive: true });
}

/**
 * Writes summary.json into the artifact directory.
 * Creates the directory if it does not exist.
 * Uses an atomic write (temp-file + rename) to avoid partial writes.
 *
 * @param {string} artifactDir
 * @param {object} data - Arbitrary serialisable summary data.
 * @returns {Promise<void>}
 */
export async function writeSummaryJson(artifactDir, data) {
  await ensureArtifactDir(artifactDir);

  const filePath = path.join(artifactDir, 'summary.json');
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const tempPath = path.join(
    artifactDir,
    `.summary.json.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    await writeFile(tempPath, serialized, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
