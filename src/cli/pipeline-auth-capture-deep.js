#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { runDeepAuthCapture as defaultRunDeepAuthCapture } from '../pipeline/authTrace/deepCapture/runDeepAuthCapture.js';

export function parseDeepCaptureArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      scenario: { type: 'string', default: 'unknown-auto' },
      label: { type: 'string', default: 'deep-run' },
      'artifact-dir': { type: 'string', default: path.join(process.cwd(), 'artifacts', 'auth-traces') },
      'start-url': { type: 'string', default: 'https://chatgpt.com/' },
      'proxy-port': { type: 'string', default: '8899' },
      'mitm-bin': { type: 'string', default: 'mitmdump' },
      'chrome-bin': { type: 'string', default: '/usr/bin/google-chrome' },
      'certutil-bin': { type: 'string', default: '' },
      'browser-url': { type: 'string', default: '' },
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
    certutilBin: values['certutil-bin'] || null,
    browserUrl: values['browser-url'] || null,
  };
}

async function waitForEnterPrompt(message = 'Press Enter to continue') {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    await rl.question(`${message}\n`);
  } finally {
    rl.close();
  }
}

export async function runDeepCaptureCli(argv, deps = {}) {
  const opts = parseDeepCaptureArgs(argv);
  const runDeepAuthCapture = deps.runDeepAuthCapture ?? defaultRunDeepAuthCapture;
  return runDeepAuthCapture(opts, { waitForEnter: deps.waitForEnter ?? waitForEnterPrompt });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runDeepCaptureCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
