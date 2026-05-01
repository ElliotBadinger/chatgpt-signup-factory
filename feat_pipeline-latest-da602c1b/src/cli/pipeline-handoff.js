import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderCommandsShell } from '../pipeline/evidence/handoff.js';

export function parseHandoffArgs(argv = []) {
  const parsed = {
    artifactDir: undefined,
    rewriteCommands: false,
    resumeCommand: undefined,
    statusCommand: undefined,
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
  write(handoffMarkdown);

  return {
    mode: 'print',
    artifactDir: options.artifactDir,
    handoffMarkdown,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runHandoffCli();
}
