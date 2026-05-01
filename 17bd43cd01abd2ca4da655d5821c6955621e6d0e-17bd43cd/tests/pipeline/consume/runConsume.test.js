import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

import { runConsume } from '../../../src/pipeline/consume/runConsume.js';
import { createPipelineStore } from '../../../src/pipeline/state/store.js';

async function readJsonl(filePath) {
  const content = await readFile(filePath, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('runConsume', () => {
  test('deterministically selects the next target and inviter, records target lifecycle events, and emits a success handoff', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-consume-'));
    const artifactDir = path.join(stateDir, 'artifacts', 'success');
    const store = createPipelineStore({ stateDir });
    const calls = [];

    await store.upsertTarget({
      id: 'target-bravo',
      status: 'pending',
      workspaceId: 'workspace-1',
      createdAt: '2026-03-13T14:00:00.000Z',
      updatedAt: '2026-03-13T14:00:00.000Z',
    });
    await store.upsertTarget({
      id: 'target-alpha',
      status: 'pending',
      workspaceId: 'workspace-1',
      createdAt: '2026-03-13T14:00:00.000Z',
      updatedAt: '2026-03-13T14:00:00.000Z',
    });
    await store.upsertInviter({ id: 'inviter-zulu', status: 'ready', workspaceId: 'workspace-1', successfulInviteCount: 2 });
    await store.upsertInviter({ id: 'inviter-alpha', status: 'ready', workspaceId: 'workspace-1', successfulInviteCount: 1 });
    await store.upsertInviter({ id: 'inviter-bravo', status: 'active', workspaceId: 'workspace-1', successfulInviteCount: 1 });
    await store.upsertWorkspaceObservation({
      workspaceId: 'workspace-1',
      observedAt: '2026-03-13T14:09:00.000Z',
      hardCapReached: false,
    });

    const writeHandoffBundle = jest.fn(async () => {});

    const result = await runConsume({
      store,
      now: () => '2026-03-13T14:10:00.000Z',
      artifactDir,
      writeHandoffBundle,
      issueInvite: jest.fn(async ({ target, inviter }) => {
        calls.push(['issueInvite', target.id, inviter.id]);
        return {
          inviteLink: 'https://chat.example.com/invite/consume-1',
          proofPaths: ['/tmp/invite-shot.png'],
        };
      }),
      pollMailbox: jest.fn(async ({ target, inviter }) => {
        calls.push(['pollMailbox', target.id, inviter.id]);
        return { mailbox: 'pending' };
      }),
      runOnboarding: jest.fn(async ({ target, inviter }) => {
        calls.push(['runOnboarding', target.id, inviter.id]);
        return { onboarding: 'pending' };
      }),
      collectProof: jest.fn(async ({ target, inviter }) => {
        calls.push(['collectProof', target.id, inviter.id]);
        return { proofPaths: ['/tmp/final-proof.png'] };
      }),
    });

    expect(result).toMatchObject({
      status: 'invited',
      target: { id: 'target-alpha', status: 'invited' },
      inviter: { id: 'inviter-alpha' },
      artifactDir,
      inviteLink: 'https://chat.example.com/invite/consume-1',
      proofPaths: ['/tmp/invite-shot.png', '/tmp/final-proof.png'],
    });

    expect(calls).toEqual([
      ['issueInvite', 'target-alpha', 'inviter-alpha'],
      ['pollMailbox', 'target-alpha', 'inviter-alpha'],
      ['runOnboarding', 'target-alpha', 'inviter-alpha'],
      ['collectProof', 'target-alpha', 'inviter-alpha'],
    ]);

    await expect(store.listTargets()).resolves.toEqual([
      {
        id: 'target-bravo',
        status: 'pending',
        workspaceId: 'workspace-1',
        createdAt: '2026-03-13T14:00:00.000Z',
        updatedAt: '2026-03-13T14:00:00.000Z',
      },
      {
        id: 'target-alpha',
        status: 'invited',
        workspaceId: 'workspace-1',
        invitedAt: '2026-03-13T14:10:00.000Z',
        createdAt: '2026-03-13T14:00:00.000Z',
        updatedAt: '2026-03-13T14:10:00.000Z',
      },
    ]);

    await expect(readJsonl(path.join(stateDir, 'run_history.jsonl'))).resolves.toEqual([
      {
        at: '2026-03-13T14:10:00.000Z',
        stage: 'consume',
        entity_type: 'target',
        entity_id: 'target-alpha',
        from_status: 'pending',
        to_status: 'selected',
        metadata: {
          inviterId: 'inviter-alpha',
          workspaceId: 'workspace-1',
        },
      },
      {
        at: '2026-03-13T14:10:00.000Z',
        stage: 'consume',
        entity_type: 'target',
        entity_id: 'target-alpha',
        from_status: 'selected',
        to_status: 'invited',
        metadata: {
          inviterId: 'inviter-alpha',
          workspaceId: 'workspace-1',
          inviteLink: 'https://chat.example.com/invite/consume-1',
        },
      },
    ]);

    expect(writeHandoffBundle).toHaveBeenCalledWith(
      artifactDir,
      expect.objectContaining({
        target: 'target-alpha',
        inviter: 'inviter-alpha',
        inviteLink: 'https://chat.example.com/invite/consume-1',
        proofPaths: ['/tmp/invite-shot.png', '/tmp/final-proof.png'],
        status: 'invited',
      }),
    );
  });

  test('halts cleanly and emits a blocked handoff when the workspace hard seat cap is active before invite issue', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-consume-'));
    const artifactDir = path.join(stateDir, 'artifacts', 'blocked');
    const store = createPipelineStore({ stateDir });

    await store.upsertTarget({
      id: 'target-seat-cap',
      status: 'pending',
      workspaceId: 'workspace-hard-cap',
      createdAt: '2026-03-13T15:00:00.000Z',
      updatedAt: '2026-03-13T15:00:00.000Z',
    });
    await store.upsertInviter({
      id: 'inviter-seat-cap',
      status: 'ready',
      workspaceId: 'workspace-hard-cap',
      successfulInviteCount: 0,
    });
    await store.upsertWorkspaceObservation({
      workspaceId: 'workspace-hard-cap',
      observedAt: '2026-03-13T15:04:00.000Z',
      memberCount: 250,
      hardCapReached: true,
    });

    const issueInvite = jest.fn(async () => ({ inviteLink: 'https://chat.example.com/should-not-run' }));
    const writeHandoffBundle = jest.fn(async () => {});

    const result = await runConsume({
      store,
      now: () => '2026-03-13T15:05:00.000Z',
      artifactDir,
      writeHandoffBundle,
      issueInvite,
    });

    expect(result).toMatchObject({
      status: 'blocked',
      target: { id: 'target-seat-cap', status: 'skipped' },
      inviter: { id: 'inviter-seat-cap' },
      artifactDir,
      inviteLink: '',
      proofPaths: [],
    });

    expect(issueInvite).not.toHaveBeenCalled();

    await expect(store.listTargets()).resolves.toEqual([
      {
        id: 'target-seat-cap',
        status: 'skipped',
        workspaceId: 'workspace-hard-cap',
        createdAt: '2026-03-13T15:00:00.000Z',
        updatedAt: '2026-03-13T15:05:00.000Z',
      },
    ]);

    await expect(readJsonl(path.join(stateDir, 'run_history.jsonl'))).resolves.toEqual([
      {
        at: '2026-03-13T15:05:00.000Z',
        stage: 'consume',
        entity_type: 'target',
        entity_id: 'target-seat-cap',
        from_status: 'pending',
        to_status: 'selected',
        metadata: {
          inviterId: 'inviter-seat-cap',
          workspaceId: 'workspace-hard-cap',
        },
      },
      {
        at: '2026-03-13T15:05:00.000Z',
        stage: 'consume',
        entity_type: 'target',
        entity_id: 'target-seat-cap',
        from_status: 'selected',
        to_status: 'skipped',
        metadata: {
          inviterId: 'inviter-seat-cap',
          workspaceId: 'workspace-hard-cap',
          reason: 'hard_seat_cap_active',
          observedAt: '2026-03-13T15:04:00.000Z',
        },
      },
    ]);

    expect(writeHandoffBundle).toHaveBeenCalledWith(
      artifactDir,
      expect.objectContaining({
        target: 'target-seat-cap',
        inviter: 'inviter-seat-cap',
        inviteLink: '',
        proofPaths: [],
        status: 'blocked',
      }),
    );
  });

  test('can advance an invited target to proven when injected hooks report proof success', async () => {
    const store = {
      listTargets: jest.fn(async () => [{ id: 'target-proven', status: 'pending', workspaceId: 'workspace-2' }]),
      listInviters: jest.fn(async () => [{ id: 'inviter-proven', status: 'ready', workspaceId: 'workspace-2', successfulInviteCount: 0 }]),
      listWorkspaceObservations: jest.fn(async () => [{ workspaceId: 'workspace-2', observedAt: '2026-03-13T16:00:00.000Z', hardCapReached: false }]),
      upsertTarget: jest.fn(async (record) => record),
      upsertInviter: jest.fn(async (record) => record),
      appendRunEvent: jest.fn(async (event) => event),
    };
    const writeHandoffBundle = jest.fn(async () => {});

    const result = await runConsume({
      store,
      now: () => '2026-03-13T16:05:00.000Z',
      artifactDir: '/tmp/run-consume-proven',
      writeHandoffBundle,
      issueInvite: async () => ({ inviteLink: 'https://chat.example.com/invite/proven', proofPaths: ['/tmp/invite.png'] }),
      pollMailbox: async () => ({ mailbox: 'accepted' }),
      runOnboarding: async () => ({ onboarding: 'complete' }),
      collectProof: async () => ({ status: 'proven', proofPaths: ['/tmp/proven.png'] }),
    });

    expect(result).toMatchObject({
      status: 'proven',
      target: { id: 'target-proven', status: 'proven' },
      inviter: { id: 'inviter-proven' },
      proofPaths: ['/tmp/invite.png', '/tmp/proven.png'],
    });

    expect(store.upsertTarget.mock.calls.map(([record]) => record.status)).toEqual([
      'selected',
      'invited',
      'proven',
    ]);
    expect(store.appendRunEvent.mock.calls.map(([event]) => [event.from_status, event.to_status])).toEqual([
      ['pending', 'selected'],
      ['selected', 'invited'],
      ['invited', 'proven'],
    ]);
    expect(writeHandoffBundle).toHaveBeenCalledWith(
      '/tmp/run-consume-proven',
      expect.objectContaining({
        target: 'target-proven',
        inviter: 'inviter-proven',
        status: 'proven',
        inviteLink: 'https://chat.example.com/invite/proven',
        proofPaths: ['/tmp/invite.png', '/tmp/proven.png'],
      }),
    );
  });
});
