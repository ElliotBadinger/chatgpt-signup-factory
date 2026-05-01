#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import readline from 'node:readline/promises';

import { runProxyOnlyAuthCapture as defaultRunProxyOnlyAuthCapture } from '../pipeline/authTrace/deepCapture/runProxyOnlyAuthCapture.js';

export function parseProxyOnlyCaptureArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      scenario: { type: 'string', default: 'unknown-auto' },
      label: { type: 'string', default: 'proxy-only-run' },
      'artifact-dir': { type: 'string', default: path.join(process.cwd(), 'artifacts', 'auth-traces') },
      'start-url': { type: 'string', default: 'https://auth.openai.com/log-in-or-create-account' },
      'proxy-port': { type: 'string', default: '9988' },
      'mitm-bin': { type: 'string', default: 'mitmdump' },
      'chrome-bin': { type: 'string', default: '/usr/bin/google-chrome' },
    },
    allowPositionals: false,
    strict: true,
  });

  return {
    scenario: values.scenario,
    label: values.label,
    artifactDir: values['artifact-dir'],
    startUrl: values['start-url'],
    proxyPort: Number(values['proxy-port']),
    mitmBin: values['mitm-bin'],
    chromeBin: values['chrome-bin'],
  };
}

export function createTtyEnterPrompt(deps = {}) {
  const createInterface = deps.createInterface ?? readline.createInterface;
  const openTty = deps.openTty ?? (() => ({
    input: createReadStream('/dev/tty'),
    output: createWriteStream('/dev/tty'),
  }));

  return async function waitForEnterPrompt(message = 'Press Enter to continue') {
    const { input, output } = openTty();
    const rl = createInterface({ input, output });
    try {
      await rl.question(`${message}\n`);
    } finally {
      rl.close();
      input.destroy?.();
      output.end?.();
    }
  };
}

export async function runProxyOnlyCaptureCli(argv, deps = {}) {
  const opts = parseProxyOnlyCaptureArgs(argv);
  const runProxyOnlyAuthCapture = deps.runProxyOnlyAuthCapture ?? defaultRunProxyOnlyAuthCapture;
  const waitForEnter = deps.waitForEnter ?? createTtyEnterPrompt();
  return runProxyOnlyAuthCapture(opts, { waitForEnter });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runProxyOnlyCaptureCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
