import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

import { writeHandoffBundle } from '../../../src/pipeline/evidence/handoff.js';
import { createPipelineStore } from '../../../src/pipeline/state/store.js';
import { runBootstrap } from '../../../src/pipeline/bootstrap/runBootstrap.js';

async function readJsonl(filePath) {
  const content = await readFile(filePath, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('runBootstrap resume behavior', () => {
  test('skips already-complete live controllers and refreshes stale live handoff bundles', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-bootstrap-resume-'));
    const artifactDir = path.join(stateDir, 'artifacts', 'bootstrap');
    const store = createPipelineStore({ stateDir });
    const hooks = {
      verifyMailboxAuthority: jest.fn(),
      createOrRecoverAgentMailController: jest.fn(),
      captureApiKey: jest.fn(),
      createInboxes: jest.fn(),
    };

    await store.upsertController({
      id: 'controller-existing-example-com',
      email: 'existing@example.com',
      status: 'ready',
      bootstrapMode: 'live',
      successfulInviteCount: 0,
      createdAt: '2026-03-13T17:00:00.000Z',
      updatedAt: '2026-03-13T17:00:00.000Z',
    });

    const staleArtifactDir = path.join(artifactDir, 'controller-existing-example-com');
    await writeHandoffBundle(staleArtifactDir, {
      target: 'existing@example.com',
      inviter: 'bootstrap',
      inviteLink: '',
      proofPaths: ['/evidence/existing-proof.json'],
      status: 'ready',
      resumeCommand: `node src/cli/pipeline-bootstrap.js --state-dir ${stateDir} --artifact-dir ${artifactDir} --root existing@example.com`,
      statusCommand: `node src/cli/pipeline-status.js --state-dir ${stateDir}`,
    });

    const result = await runBootstrap({
      store,
      artifactDir,
      candidateRootEmails: ['existing@example.com'],
      now: () => '2026-03-13T17:05:00.000Z',
      ...hooks,
    });

    expect(result.controllers).toEqual([]);
    expect(hooks.verifyMailboxAuthority).not.toHaveBeenCalled();
    expect(hooks.createOrRecoverAgentMailController).not.toHaveBeenCalled();
    expect(hooks.captureApiKey).not.toHaveBeenCalled();
    expect(hooks.createInboxes).not.toHaveBeenCalled();

    const refreshedSummary = JSON.parse(await readFile(path.join(staleArtifactDir, 'summary.json'), 'utf8'));
    expect(refreshedSummary.resumeCommand).toContain('--live');
    expect(refreshedSummary.resumeCommand).not.toContain('--dry-run');
    expect(refreshedSummary.proofPaths).toEqual(['/evidence/existing-proof.json']);

    const refreshedCommands = await readFile(path.join(staleArtifactDir, 'commands.sh'), 'utf8');
    expect(refreshedCommands).toContain('--live');

    const refreshedMarkdown = await readFile(path.join(staleArtifactDir, 'handoff.md'), 'utf8');
    expect(refreshedMarkdown).toContain('--live');
  });

  test('writes a fresh handoff bundle when bootstrap remains incomplete', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-bootstrap-resume-'));
    const artifactDir = path.join(stateDir, 'artifacts', 'bootstrap');
    const store = createPipelineStore({ stateDir });

    const writeHandoffBundle = jest.fn(async () => {});

    await expect(
      runBootstrap({
        store,
        artifactDir,
        candidateRootEmails: ['broken@example.com'],
        now: () => '2026-03-13T17:10:00.000Z',
        writeHandoffBundle,
        verifyMailboxAuthority: async () => {
          throw new Error('mailbox authority check failed');
        },
      }),
    ).rejects.toThrow('mailbox authority check failed');

    expect(writeHandoffBundle).toHaveBeenCalledWith(
      path.join(artifactDir, 'controller-broken-example-com'),
      expect.objectContaining({
        target: 'broken@example.com',
        inviter: 'bootstrap',
        status: 'failed',
        resumeCommand: expect.stringContaining('pipeline-bootstrap.js'),
        statusCommand: expect.stringContaining('pipeline-status.js'),
      }),
    );

    await expect(readJsonl(path.join(stateDir, 'run_history.jsonl'))).resolves.toEqual([
      {
        at: '2026-03-13T17:10:00.000Z',
        stage: 'bootstrap',
        entity_type: 'controller',
        entity_id: 'controller-broken-example-com',
        from_status: 'pending',
        to_status: 'failed',
        metadata: {
          dryRun: false,
          email: 'broken@example.com',
          error: 'mailbox authority check failed',
        },
      },
    ]);
  });
});
