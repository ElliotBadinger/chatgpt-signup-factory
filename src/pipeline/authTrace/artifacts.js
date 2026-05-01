import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function slugifyLabel(label) {
  return String(label ?? 'run')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'run';
}

export function traceRunId(label = 'run', now = new Date()) {
  const iso = now.toISOString().replace(/:/g, '-').replace(/\./g, '-');
  return `${iso}-${slugifyLabel(label)}`;
}

export function traceArtifactDir(baseDir, runId) {
  return path.join(baseDir, runId);
}

export async function ensureTraceRunDir(runDir) {
  await mkdir(runDir, { recursive: true });
  for (const child of ['checkpoints', 'screenshots', 'requests', 'responses']) {
    await mkdir(path.join(runDir, child), { recursive: true });
  }
}
