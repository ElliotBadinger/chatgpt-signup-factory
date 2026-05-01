#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { runAuthTrace as defaultRunAuthTrace } from '../pipeline/authTrace/runAuthTrace.js';

export function parseAuthTraceArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string', default: 'manual' },
      scenario: { type: 'string', default: 'unknown-auto' },
      label: { type: 'string', default: 'run' },
      'artifact-dir': { type: 'string', default: path.join(process.cwd(), 'artifacts', 'auth-traces') },
      'start-url': { type: 'string', default: 'https://chatgpt.com/' },
    },
    allowPositionals: false,
    strict: true,
  });

  return {
    mode: values.mode,
    scenario: values.scenario,
    label: values.label,
    artifactDir: values['artifact-dir'],
    startUrl: values['start-url'],
  };
}

export async function waitForEnterPrompt(message = 'Press Enter to continue') {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    await rl.question(`${message}\n`);
  } finally {
    rl.close();
  }
}

export async function runAuthTraceCli(argv, deps = {}) {
  const opts = parseAuthTraceArgs(argv);
  const runAuthTrace = deps.runAuthTrace ?? defaultRunAuthTrace;
  const runDeps = {};
  if (opts.mode === 'manual') {
    runDeps.waitForEnter = deps.waitForEnter ?? waitForEnterPrompt;
  }
  return runAuthTrace(opts, runDeps);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runAuthTraceCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
