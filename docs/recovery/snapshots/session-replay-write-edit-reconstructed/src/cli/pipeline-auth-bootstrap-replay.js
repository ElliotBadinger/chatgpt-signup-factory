#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { replayBrowserlessBootstrap } from '../pipeline/authTrace/browserlessBootstrapReplay.js';

export function parseBrowserlessBootstrapReplayArgs(argv = process.argv.slice(2)) {
  let runDir = null;
  let planPath = null;
  let outputPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run-dir' && argv[i + 1]) {
      runDir = argv[i + 1];
      i++;
      continue;
    }
    if (argv[i] === '--plan' && argv[i + 1]) {
      planPath = argv[i + 1];
      i++;
      continue;
    }
    if (argv[i] === '--output' && argv[i + 1]) {
      outputPath = argv[i + 1];
      i++;
    }
  }
  return { runDir, planPath, outputPath };
}

async function main() {
  const args = parseBrowserlessBootstrapReplayArgs();
  const effectivePlanPath = args.planPath || (args.runDir ? path.join(args.runDir, 'browserless-bootstrap-plan.json') : null);
  const effectiveOutputPath = args.outputPath || (args.runDir ? path.join(args.runDir, 'browserless-bootstrap-replay.json') : null);
  if (!effectivePlanPath || !effectiveOutputPath) {
    console.error('Usage: pipeline-auth-bootstrap-replay --run-dir <path> [--plan <path>] [--output <path>]');
    process.exit(1);
  }
  const plan = JSON.parse(await readFile(effectivePlanPath, 'utf8'));
  const result = await replayBrowserlessBootstrap({ plan });
  await writeFile(effectiveOutputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1]?.endsWith('pipeline-auth-bootstrap-replay.js')) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
