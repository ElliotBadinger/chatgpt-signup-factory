import { fileURLToPath } from 'node:url';

import { loadJsonFile } from '../pipeline/state/store.js';

export function parseStatusArgs(argv = []) {
  const parsed = {
    stateDir: '.',
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--state-dir') {
      parsed.stateDir = argv[index + 1];
      index += 1;
    }
  }

  return parsed;
}

export async function summarizeRegistryState(stateDir) {
  const [controllers, targets, inviters, workspaceObservations] = await Promise.all([
    loadJsonFile(`${stateDir}/controller_registry.json`, []),
    loadJsonFile(`${stateDir}/target_registry.json`, []),
    loadJsonFile(`${stateDir}/inviter_registry.json`, []),
    loadJsonFile(`${stateDir}/workspace_observations.json`, []),
  ]);

  return {
    stateDir,
    controllerCount: controllers.length,
    targetCount: targets.length,
    inviterCount: inviters.length,
    workspaceObservationCount: workspaceObservations.length,
  };
}

export async function runStatusCli(argv = process.argv.slice(2), { write = (line) => process.stdout.write(line) } = {}) {
  const { stateDir } = parseStatusArgs(argv);
  const summary = await summarizeRegistryState(stateDir);

  write(`State directory: ${summary.stateDir}\n`);
  write(`Controllers: ${summary.controllerCount}\n`);
  write(`Targets: ${summary.targetCount}\n`);
  write(`Inviters: ${summary.inviterCount}\n`);
  write(`Workspace observations: ${summary.workspaceObservationCount}\n`);

  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runStatusCli();
}
