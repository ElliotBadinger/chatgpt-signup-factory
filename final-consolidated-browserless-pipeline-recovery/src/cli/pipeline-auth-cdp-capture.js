#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import readline from 'node:readline/promises';

import { runAuthCdpCapture as defaultRunAuthCdpCapture } from '../pipeline/authTrace/cdpLive/runAuthCdpCapture.js';

export function parseAuthCdpCaptureArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      scenario: { type: 'string', default: 'unknown-auto' },
      label: { type: 'string', default: 'cdp-run' },
      'artifact-dir': { type: 'string', default: path.join(process.cwd(), 'artifacts', 'auth-traces') },
      'start-url': { type: 'string', default: 'https://auth.openai.com/log-in-or-create-account' },
      target: { type: 'string', default: '' },
      'cdp-port': { type: 'string', default: '' },
      'cdp-ws-url': { type: 'string', default: '' },
    },
    allowPositionals: false,
    strict: true,
  });

  return {
    scenario: values.scenario,
    label: values.label,
    artifactDir: values['artifact-dir'],
    startUrl: values['start-url'],
    target: values.target || null,
    cdpPort: values['cdp-port'] ? Number(values['cdp-port']) : null,
    cdpWsUrl: values['cdp-ws-url'] || null,
  };
}

function createTtyEnterPrompt() {
  return async function waitForEnter(message = 'Press Enter to continue') {
    const input = createReadStream('/dev/tty');
    const output = createWriteStream('/dev/tty');
    const rl = readline.createInterface({ input, output });
    try {
      await rl.question(`${message}\n`);
    } finally {
      rl.close();
      input.destroy?.();
      output.end?.();
    }
  };
}

export async function runAuthCdpCaptureCli(argv, deps = {}) {
  const opts = parseAuthCdpCaptureArgs(argv);
  const runAuthCdpCapture = deps.runAuthCdpCapture ?? defaultRunAuthCdpCapture;
  const waitForEnter = deps.waitForEnter ?? createTtyEnterPrompt();
  return runAuthCdpCapture(opts, { waitForEnter });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runAuthCdpCaptureCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
