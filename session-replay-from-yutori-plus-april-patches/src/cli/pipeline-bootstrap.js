import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createRealStage1LiveHooks } from '../pipeline/bootstrap/realStage1.js';
import { runBootstrap as defaultRunBootstrap } from '../pipeline/bootstrap/runBootstrap.js';

export function parseBootstrapArgs(argv = []) {
  const parsed = {
    candidateRootEmails: [],
    stateDir: undefined,
    artifactDir: undefined,
    manifest: undefined,
    dryRun: false,
    live: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--root') {
      parsed.candidateRootEmails.push(argv[index + 1]);
      index += 1;
      continue;
    }

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

    if (token === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }

    if (token === '--live') {
      parsed.live = true;
    }
  }

  return parsed;
}

export async function loadBootstrapManifest(manifestPath, { read = readFile } = {}) {
  const raw = await read(manifestPath, 'utf8');
  return JSON.parse(raw);
}

export async function resolveBootstrapOptions(argv = [], deps = {}) {
  const parsed = parseBootstrapArgs(argv);
  if (!parsed.manifest) {
    return parsed;
  }

  const manifest = await loadBootstrapManifest(parsed.manifest, deps);
  return {
    candidateRootEmails: parsed.candidateRootEmails.length > 0 ? parsed.candidateRootEmails : (manifest.candidateRootEmails ?? []),
    stateDir: parsed.stateDir ?? manifest.stateDir,
    artifactDir: parsed.artifactDir ?? manifest.artifactDir,
    dryRun: parsed.dryRun || Boolean(manifest.dryRun),
    live: parsed.live || Boolean(manifest.live),
  };
}

export async function runBootstrapCli(argv = process.argv.slice(2), { runBootstrap = defaultRunBootstrap, ...deps } = {}) {
  const options = await resolveBootstrapOptions(argv, deps);

  if (!options.live) {
    return runBootstrap(options);
  }

  const liveHooks = createRealStage1LiveHooks({
    artifactDir: options.artifactDir,
    cwd: process.cwd(),
  });

  try {
    return await runBootstrap({
      ...options,
      dryRun: false,
      verifyMailboxAuthority: liveHooks.verifyMailboxAuthority,
      createOrRecoverAgentMailController: liveHooks.createOrRecoverAgentMailController,
      captureApiKey: liveHooks.captureApiKey,
      createInboxes: liveHooks.createInboxes,
    });
  } finally {
    await liveHooks.cleanup();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runBootstrapCli();
}
