/**
 * Handoff bundle writer.
 * Owns markdown/shell command bundle writing for direct-DM-friendly handoff output.
 * Pure file-writing logic — no browser/network behavior.
 *
 * A handoff bundle consists of:
 *   - handoff.md   — human-readable summary with all DM-friendly fields
 *   - commands.sh  — shell commands for resume and status
 *   - summary.json — machine-readable copy written via artifacts module
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensureArtifactDir, writeSummaryJson } from './artifacts.js';
import { sendHandoffViaResend, shouldSendResendHandoff } from './resendNotifier.js';

/**
 * @typedef {object} HandoffData
 * @property {string}   target         - Target identifier (email, username, id).
 * @property {string}   inviter        - Inviter identifier.
 * @property {string}   inviteLink     - Direct invite URL.
 * @property {string[]} proofPaths     - Paths to evidence files (screenshots, DOM, etc.).
 * @property {string}   status         - Current target/run status.
 * @property {string}   resumeCommand  - Shell command to resume this run.
 * @property {string}   statusCommand  - Shell command to check run status.
 * @property {string}   [blocker]      - Exact blocker text for blocked runs.
 * @property {string}   [nextCommand]  - Suggested follow-up command for blocked runs.
 */

function renderProofPathLines(proofPaths) {
  if (proofPaths.length === 0) {
    return ['_(none)_'];
  }

  return proofPaths.map((proofPath) => `- ${proofPath}`);
}

/**
 * Renders the handoff markdown content.
 * Deterministic: same input always produces the same string.
 *
 * @param {HandoffData} handoff
 * @returns {string}
 */
export function renderHandoffMarkdown(handoff) {
  const { target, inviter, inviteLink, proofPaths, status, resumeCommand, statusCommand, blocker, nextCommand } = handoff;

  const lines = [
    '# Handoff Summary',
    '',
    '## Run Details',
    '',
    `- **Target**: ${target}`,
    `- **Inviter**: ${inviter}`,
    `- **Invite Link**: ${inviteLink}`,
    `- **Status**: ${status}`,
    '',
    '## Entity IDs',
    '',
    `- **Target ID**: ${target}`,
    `- **Inviter ID**: ${inviter}`,
    '',
    '### Proof Path References',
    '',
    ...renderProofPathLines(proofPaths),
    '',
  ];

  if (typeof blocker === 'string' && blocker.length > 0) {
    lines.push('## Blocker', '', blocker, '');
  }

  lines.push(
    '## Direct Command Bundle',
    '',
    'The commands below are copy-pasteable and contract-stable.',
    '',
    '### Resume Command',
    '',
    '```sh',
    resumeCommand,
    '```',
    '',
    '### Status Command',
    '',
    '```sh',
    statusCommand,
    '```',
    '',
  );

  if (typeof nextCommand === 'string' && nextCommand.length > 0) {
    lines.push('### Suggested Next Command', '', '```sh', nextCommand, '```', '');
  }

  return lines.join('\n');
}

/**
 * Renders the commands shell script content.
 * Deterministic: same input always produces the same string.
 *
 * @param {HandoffData} handoff
 * @returns {string}
 */
export function renderCommandsShell(handoff) {
  const { resumeCommand, statusCommand, nextCommand } = handoff;

  const lines = [
    '#!/usr/bin/env sh',
    '# Auto-generated handoff commands — stable direct-command contract. Do not edit manually.',
    '# SECTION: resume',
    resumeCommand,
    '',
    '# SECTION: status',
    statusCommand,
    '',
  ];

  if (typeof nextCommand === 'string' && nextCommand.length > 0) {
    lines.push('# SECTION: next', nextCommand, '');
  }

  return lines.join('\n');
}

/**
 * Writes the full handoff bundle (handoff.md, commands.sh, summary.json)
 * into the given artifact directory.
 * Creates the directory if it does not exist.
 *
 * @param {string}     artifactDir
 * @param {HandoffData} handoff
 * @returns {Promise<void>}
 */
export async function writeHandoffBundle(artifactDir, handoff) {
  await ensureArtifactDir(artifactDir);

  const handoffMarkdown = renderHandoffMarkdown(handoff);
  const commandsShell = renderCommandsShell(handoff);
  let resend = null;

  await Promise.all([
    writeFile(path.join(artifactDir, 'handoff.md'), handoffMarkdown, 'utf8'),
    writeFile(path.join(artifactDir, 'commands.sh'), commandsShell, 'utf8'),
  ]);

  if (shouldSendResendHandoff(handoff.resend)) {
    resend = await sendHandoffViaResend(handoffMarkdown, handoff.resend ?? {});
  }

  await writeSummaryJson(artifactDir, {
    target: handoff.target,
    inviter: handoff.inviter,
    inviteLink: handoff.inviteLink,
    proofPaths: handoff.proofPaths,
    status: handoff.status,
    resumeCommand: handoff.resumeCommand,
    statusCommand: handoff.statusCommand,
    blocker: handoff.blocker,
    nextCommand: handoff.nextCommand,
    notifications: resend ? { resend } : undefined,
  });

  return {
    artifactDir,
    notifications: resend ? { resend } : {},
  };
}
