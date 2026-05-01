import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderCommandsShell } from '../pipeline/evidence/handoff.js';
import { sendHandoffViaResend } from '../pipeline/evidence/resendNotifier.js';

export function parseHandoffArgs(argv = []) {
  const parsed = {
    artifactDir: undefined,
    rewriteCommands: false,
    resumeCommand: undefined,
    statusCommand: undefined,
    sendResend: false,
    resendApiKey: undefined,
    resendFrom: undefined,
    resendTo: undefined,
    resendSubject: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--artifact-dir') {
      parsed.artifactDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === '--rewrite-commands') {
      parsed.rewriteCommands = true;
      continue;
    }

    if (token === '--resume-command') {
      parsed.resumeCommand = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === '--status-command') {
      parsed.statusCommand = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === '--send-resend') {
      parsed.sendResend = true;
      continue;
    }

    if (token === '--resend-api-key') {
      parsed.resendApiKey = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === '--resend-from') {
      parsed.resendFrom = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === '--resend-to') {
      parsed.resendTo = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === '--resend-subject') {
      parsed.resendSubject = argv[index + 1];
      index += 1;
    }
  }

  return parsed;
}

export function buildCommandsBundle({ resumeCommand, statusCommand }) {
  return renderCommandsShell({ resumeCommand, statusCommand });
}

export async function runHandoffCli(argv = process.argv.slice(2), { write = (chunk) => process.stdout.write(chunk) } = {}) {
  const options = parseHandoffArgs(argv);

  if (options.rewriteCommands) {
    const commands = buildCommandsBundle(options);
    await writeFile(path.join(options.artifactDir, 'commands.sh'), commands, 'utf8');
    return {
      mode: 'rewrite',
      artifactDir: options.artifactDir,
      commands,
    };
  }

  const handoffMarkdown = await readFile(path.join(options.artifactDir, 'handoff.md'), 'utf8');
  let resend = null;
  if (options.sendResend) {
    resend = await sendHandoffViaResend(handoffMarkdown, {
      apiKey: options.resendApiKey,
      from: options.resendFrom,
      to: options.resendTo,
      subject: options.resendSubject,
    });
  }

  write(handoffMarkdown);

  return {
    mode: 'print',
    artifactDir: options.artifactDir,
    handoffMarkdown,
    resend,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runHandoffCli();
}
