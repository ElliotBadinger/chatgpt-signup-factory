import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

describe('pipeline CLI helpers', () => {
  test('router-onboard-inboxes preserves the legacy browser result contract', async () => {
    const source = await readFile(path.resolve('src/cli/router-onboard-inboxes.js'), 'utf8');

    expect(source).toContain('legacyBrowserFlow: true');
    expect(source).toContain('result.capture.finalUrl');
    expect(source).toContain('result.otp');
  });

  test('bootstrap CLI parses candidate roots and directory flags, then delegates to runBootstrap', async () => {
    const { parseBootstrapArgs, runBootstrapCli } = await import('../../src/cli/pipeline-bootstrap.js');

    expect(
      parseBootstrapArgs([
        '--root',
        'Root+One@example.com',
        '--root',
        'root.two@example.com',
        '--state-dir',
        '/tmp/state',
        '--artifact-dir',
        '/tmp/artifacts',
        '--dry-run',
      ]),
    ).toMatchObject({
      candidateRootEmails: ['Root+One@example.com', 'root.two@example.com'],
      stateDir: '/tmp/state',
      artifactDir: '/tmp/artifacts',
      dryRun: true,
    });

    const runBootstrap = jest.fn(async (options) => ({
      status: 'ok',
      received: options,
    }));

    const result = await runBootstrapCli(
      ['--root', 'root@example.com', '--state-dir', '/tmp/state', '--artifact-dir', '/tmp/artifacts'],
      { runBootstrap },
    );

    expect(runBootstrap).toHaveBeenCalledWith(expect.objectContaining({
      candidateRootEmails: ['root@example.com'],
      stateDir: '/tmp/state',
      artifactDir: '/tmp/artifacts',
      dryRun: false,
    }));
    expect(result).toMatchObject({
      status: 'ok',
      received: expect.objectContaining({
        candidateRootEmails: ['root@example.com'],
        stateDir: '/tmp/state',
        artifactDir: '/tmp/artifacts',
        dryRun: false,
      }),
    });
  });

  test('consume CLI parses --resume and passes it through to the consume runner', async () => {
    const { parseConsumeArgs, runConsumeCli } = await import('../../src/cli/pipeline-consume.js');

    expect(
      parseConsumeArgs([
        '--state-dir',
        '/tmp/state',
        '--artifact-dir',
        '/tmp/artifacts/run-1',
        '--resume',
        'run-1',
      ]),
    ).toEqual({
      stateDir: '/tmp/state',
      artifactDir: '/tmp/artifacts/run-1',
      manifest: undefined,
      resume: 'run-1',
    });

    const runConsume = jest.fn(async (options) => ({ status: 'invited', options }));
    const result = await runConsumeCli(['--resume', 'run-2', '--artifact-dir', '/tmp/artifacts/run-2'], { runConsume });

    expect(runConsume).toHaveBeenCalledWith({
      stateDir: undefined,
      artifactDir: '/tmp/artifacts/run-2',
      manifest: undefined,
      resume: 'run-2',
    });
    expect(result).toEqual({
      status: 'invited',
      options: {
        stateDir: undefined,
        artifactDir: '/tmp/artifacts/run-2',
        manifest: undefined,
        resume: 'run-2',
      },
    });
  });

  test('bootstrap and consume CLIs can load options from example manifests', async () => {
    const {
      resolveBootstrapOptions,
      runBootstrapCli,
    } = await import('../../src/cli/pipeline-bootstrap.js');
    const {
      resolveConsumeOptions,
      runConsumeCli,
    } = await import('../../src/cli/pipeline-consume.js');

    const bootstrapManifest = {
      candidateRootEmails: ['root1@example.com', 'root2@example.com'],
      stateDir: '/tmp/bootstrap-state',
      artifactDir: '/tmp/bootstrap-artifacts',
      dryRun: true,
    };
    const consumeManifest = {
      stateDir: '/tmp/consume-state',
      artifactDir: '/tmp/consume-artifacts/run-1',
      resume: 'run-1',
    };

    await expect(
      resolveBootstrapOptions(['--manifest', '/tmp/bootstrap-manifest.json'], {
        read: async () => JSON.stringify(bootstrapManifest),
      }),
    ).resolves.toMatchObject(bootstrapManifest);

    await expect(
      resolveConsumeOptions(['--manifest', '/tmp/consume-manifest.json'], {
        read: async () => JSON.stringify(consumeManifest),
      }),
    ).resolves.toEqual(consumeManifest);

    const runBootstrap = jest.fn(async (options) => options);
    const runConsume = jest.fn(async (options) => options);

    await runBootstrapCli(['--manifest', '/tmp/bootstrap-manifest.json'], {
      runBootstrap,
      read: async () => JSON.stringify(bootstrapManifest),
    });
    await runConsumeCli(['--manifest', '/tmp/consume-manifest.json'], {
      runConsume,
      read: async () => JSON.stringify(consumeManifest),
    });

    expect(runBootstrap).toHaveBeenCalledWith(expect.objectContaining(bootstrapManifest));
    expect(runConsume).toHaveBeenCalledWith(consumeManifest);
  });

  test('status CLI prints registry summaries from state files', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-status-'));
    const { runStatusCli } = await import('../../src/cli/pipeline-status.js');

    await writeFile(
      path.join(stateDir, 'controller_registry.json'),
      `${JSON.stringify([{ id: 'c-1' }, { id: 'c-2' }], null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(stateDir, 'target_registry.json'),
      `${JSON.stringify([{ id: 't-1' }, { id: 't-2' }, { id: 't-3' }], null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(stateDir, 'inviter_registry.json'),
      `${JSON.stringify([{ id: 'i-1' }], null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(stateDir, 'workspace_observations.json'),
      `${JSON.stringify([{ workspaceId: 'w-1' }, { workspaceId: 'w-2' }], null, 2)}\n`,
      'utf8',
    );

    const writes = [];
    const summary = await runStatusCli(['--state-dir', stateDir], {
      write: (line) => writes.push(line),
    });

    expect(summary).toEqual({
      stateDir,
      controllerCount: 2,
      targetCount: 3,
      inviterCount: 1,
      workspaceObservationCount: 2,
    });
    expect(writes.join('')).toContain(`State directory: ${stateDir}`);
    expect(writes.join('')).toContain('Controllers: 2');
    expect(writes.join('')).toContain('Targets: 3');
    expect(writes.join('')).toContain('Inviters: 1');
    expect(writes.join('')).toContain('Workspace observations: 2');
  });

  test('handoff CLI prints handoff markdown and can rewrite commands.sh from explicit inputs', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-handoff-'));
    const { runHandoffCli } = await import('../../src/cli/pipeline-handoff.js');

    await writeFile(path.join(artifactDir, 'handoff.md'), '# Existing handoff\n', 'utf8');
    await writeFile(path.join(artifactDir, 'commands.sh'), '#!/usr/bin/env sh\n# old\n', 'utf8');

    const writes = [];
    const printed = await runHandoffCli(['--artifact-dir', artifactDir], {
      write: (chunk) => writes.push(chunk),
    });

    expect(printed.mode).toBe('print');
    expect(printed.handoffMarkdown).toBe('# Existing handoff\n');
    expect(writes.join('')).toBe('# Existing handoff\n');

    const rewritten = await runHandoffCli(
      [
        '--artifact-dir',
        artifactDir,
        '--rewrite-commands',
        '--resume-command',
        'node src/cli/pipeline-consume.js --resume run-9',
        '--status-command',
        'node src/cli/pipeline-status.js --state-dir ./state',
      ],
      {
        write: () => {},
      },
    );

    expect(rewritten.mode).toBe('rewrite');
    expect(rewritten.commands).toContain('node src/cli/pipeline-consume.js --resume run-9');
    expect(rewritten.commands).toContain('node src/cli/pipeline-status.js --state-dir ./state');

    const commands = await readFile(path.join(artifactDir, 'commands.sh'), 'utf8');
    expect(commands).toBe(rewritten.commands);
  });

  test('handoff CLI can send the printed handoff through Resend', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-handoff-'));
    const { runHandoffCli } = await import('../../src/cli/pipeline-handoff.js');

    await writeFile(path.join(artifactDir, 'handoff.md'), '# Existing handoff\n', 'utf8');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'email-cli' }),
    }));

    try {
      const result = await runHandoffCli(
        [
          '--artifact-dir',
          artifactDir,
          '--send-resend',
          '--resend-api-key',
          're_1234567890abcdef',
          '--resend-from',
          'pipeline@example.com',
          '--resend-to',
          'ops@example.com',
        ],
        { write: () => {} },
      );

      expect(result.resend).toMatchObject({
        status: 'sent',
        provider: 'resend',
        id: 'email-cli',
      });
      expect(globalThis.fetch).toHaveBeenCalledWith('https://api.resend.com/emails', expect.any(Object));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
