import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runConsume as defaultRunConsume } from '../pipeline/consume/runConsume.js';

export function parseConsumeArgs(argv = []) {
  const parsed = {
    stateDir: undefined,
    artifactDir: undefined,
    manifest: undefined,
    resume: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--state-dir') {
      parsed.stateDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === '--artifact-dir') {
      parsed.artifactDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === '--manifest') {
      parsed.manifest = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === '--resume') {
      parsed.resume = argv[index + 1];
      index += 1;
    }
  }

  return parsed;
}

export async function loadConsumeManifest(manifestPath, { read = readFile } = {}) {
  const raw = await read(manifestPath, 'utf8');
  return JSON.parse(raw);
}

export async function resolveConsumeOptions(argv = [], deps = {}) {
  const parsed = parseConsumeArgs(argv);
  if (!parsed.manifest) {
    return parsed;
  }

  const manifest = await loadConsumeManifest(parsed.manifest, deps);
  return {
    stateDir: parsed.stateDir ?? manifest.stateDir,
    artifactDir: parsed.artifactDir ?? manifest.artifactDir,
    resume: parsed.resume ?? manifest.resume,
  };
}

export async function runConsumeCli(argv = process.argv.slice(2), { runConsume = defaultRunConsume, ...deps } = {}) {
  const options = await resolveConsumeOptions(argv, deps);
  return runConsume(options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runConsumeCli();
}
