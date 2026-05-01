import { describe, expect, jest, test } from '@jest/globals';

import { runConsume } from '../../../src/pipeline/consume/runConsume.js';

function createMemoryStore(targets, inviters = [{ id: 'inviter-1', status: 'ready', workspaceId: 'workspace-1', successfulInviteCount: 0 }]) {
  const targetRecords = targets.map((target) => ({ ...target }));
  const inviterRecords = inviters.map((inviter) => ({ ...inviter }));
  const runEvents = [];

  return {
    async listTargets() {
      return targetRecords.map((target) => ({ ...target }));
    },
    async upsertTarget(update) {
      const index = targetRecords.findIndex((target) => target.id === update.id);
      const next = index >= 0 ? { ...targetRecords[index], ...update } : { ...update };
      if (index >= 0) {
        targetRecords[index] = next;
      } else {
        targetRecords.push(next);
      }
      return { ...next };
    },
    async listInviters() {
      return inviterRecords.map((inviter) => ({ ...inviter }));
    },
    async upsertInviter(update) {
      const index = inviterRecords.findIndex((inviter) => inviter.id === update.id);
      const next = index >= 0 ? { ...inviterRecords[index], ...update } : { ...update };
      if (index >= 0) {
        inviterRecords[index] = next;
      } else {
        inviterRecords.push(next);
      }
      return { ...next };
    },
    async listWorkspaceObservations() {
      return [];
    },
    async appendRunEvent(event) {
      runEvents.push(event);
      return event;
    },
    snapshot() {
      return {
        targets: targetRecords.map((target) => ({ ...target })),
        inviters: inviterRecords.map((inviter) => ({ ...inviter })),
        runEvents: runEvents.map((event) => ({ ...event })),
      };
    },
  };
}

describe('runConsume resume behavior', () => {
  test.each([
    {
      status: 'invite-sent',
      expectedCalls: ['pollMailbox', 'runOnboarding', 'collectProof'],
    },
    {
      status: 'invite-received',
      expectedCalls: ['runOnboarding', 'collectProof'],
    },
    {
      status: 'auth-started',
      expectedCalls: ['runOnboarding', 'collectProof'],
    },
    {
      status: 'joined',
      expectedCalls: ['collectProof'],
    },
  ])('resumes from $status without replaying earlier steps', async ({ status, expectedCalls }) => {
    const store = createMemoryStore([
      { id: 'target-resume', status, workspaceId: 'workspace-1', updatedAt: '2026-03-13T16:00:00.000Z' },
      { id: 'target-next', status: 'pending', workspaceId: 'workspace-1', updatedAt: '2026-03-13T16:00:00.000Z' },
    ]);
    const calls = [];

    const result = await runConsume({
      store,
      now: () => '2026-03-13T16:05:00.000Z',
      writeHandoffBundle: jest.fn(async () => {}),
      issueInvite: jest.fn(async () => {
        calls.push('issueInvite');
        return { inviteLink: 'https://chat.example.com/invite/should-not-run' };
      }),
      pollMailbox: jest.fn(async () => {
        calls.push('pollMailbox');
        return { status: 'invite-received', proofPaths: ['/tmp/mailbox.png'] };
      }),
      runOnboarding: jest.fn(async () => {
        calls.push('runOnboarding');
        return { status: 'joined', proofPaths: ['/tmp/onboarding.png'] };
      }),
      collectProof: jest.fn(async () => {
        calls.push('collectProof');
        return { status: 'proven', proofPaths: ['/tmp/proven.png'] };
      }),
    });

    expect(calls).toEqual(expectedCalls);
    expect(result).toMatchObject({
      status: 'proven',
      target: { id: 'target-resume', status: 'proven' },
      proofPaths: expect.arrayContaining(['/tmp/proven.png']),
    });
    expect(store.snapshot().targets).toEqual([
      expect.objectContaining({ id: 'target-resume', status: 'proven', updatedAt: '2026-03-13T16:05:00.000Z' }),
      expect.objectContaining({ id: 'target-next', status: 'pending' }),
    ]);
  });

  test('persists proven targets before selecting the next target and never regresses already-proven work', async () => {
    const store = createMemoryStore([
      { id: 'target-done', status: 'proven', workspaceId: 'workspace-1', updatedAt: '2026-03-13T15:55:00.000Z' },
      { id: 'target-resume', status: 'joined', workspaceId: 'workspace-1', updatedAt: '2026-03-13T16:00:00.000Z' },
      { id: 'target-next', status: 'pending', workspaceId: 'workspace-1', updatedAt: '2026-03-13T16:00:00.000Z' },
    ]);

    const firstRun = await runConsume({
      store,
      now: () => '2026-03-13T16:05:00.000Z',
      writeHandoffBundle: jest.fn(async () => {}),
      issueInvite: jest.fn(async () => ({ inviteLink: 'https://chat.example.com/invite/target-next' })),
      pollMailbox: jest.fn(async () => ({ status: 'invite-received' })),
      runOnboarding: jest.fn(async () => ({ status: 'joined' })),
      collectProof: jest.fn(async ({ target }) => ({
        status: target.id === 'target-resume' ? 'proven' : 'invited',
        proofPaths: [`/tmp/${target.id}.png`],
      })),
    });

    expect(firstRun).toMatchObject({
      status: 'proven',
      target: { id: 'target-resume', status: 'proven' },
    });
    expect(store.snapshot().targets).toEqual([
      expect.objectContaining({ id: 'target-done', status: 'proven' }),
      expect.objectContaining({ id: 'target-resume', status: 'proven' }),
      expect.objectContaining({ id: 'target-next', status: 'pending' }),
    ]);

    const secondRunIssueInvite = jest.fn(async () => ({ inviteLink: 'https://chat.example.com/invite/target-next' }));

    const secondRun = await runConsume({
      store,
      now: () => '2026-03-13T16:06:00.000Z',
      writeHandoffBundle: jest.fn(async () => {}),
      issueInvite: secondRunIssueInvite,
      pollMailbox: jest.fn(async () => ({ status: 'invite-received' })),
      runOnboarding: jest.fn(async () => ({ status: 'joined' })),
      collectProof: jest.fn(async () => ({ status: 'invited' })),
    });

    expect(secondRunIssueInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ id: 'target-next', status: 'selected' }),
      }),
    );
    expect(secondRun).toMatchObject({
      status: 'invited',
      target: { id: 'target-next', status: 'invited' },
    });
    expect(store.snapshot().targets).toEqual([
      expect.objectContaining({ id: 'target-done', status: 'proven' }),
      expect.objectContaining({ id: 'target-resume', status: 'proven' }),
      expect.objectContaining({ id: 'target-next', status: 'invited' }),
    ]);
  });
});
