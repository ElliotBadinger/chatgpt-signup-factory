import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

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
  test('skips already-complete controllers instead of recreating them', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-bootstrap-resume-'));
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
      successfulInviteCount: 0,
      createdAt: '2026-03-13T17:00:00.000Z',
      updatedAt: '2026-03-13T17:00:00.000Z',
    });

    const result = await runBootstrap({
      store,
      candidateRootEmails: ['existing@example.com'],
      now: () => '2026-03-13T17:05:00.000Z',
      ...hooks,
    });

    expect(result.controllers).toEqual([]);
    expect(hooks.verifyMailboxAuthority).not.toHaveBeenCalled();
    expect(hooks.createOrRecoverAgentMailController).not.toHaveBeenCalled();
    expect(hooks.captureApiKey).not.toHaveBeenCalled();
    expect(hooks.createInboxes).not.toHaveBeenCalled();
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
