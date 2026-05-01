import { describe, test, expect, jest } from '@jest/globals';

import {
  ensureWorkspaceInvite,
  findInviteByEmail,
  normalizeInviteStatus,
  selectOldestPrunableInvite,
} from '../../../src/pipeline/rotation/browserlessInvitePolicy.js';

describe('normalizeInviteStatus', () => {
  test('canonicalizes supported string statuses and known numeric pending state', () => {
    expect(normalizeInviteStatus({ status: ' cancelled ' })).toBe('cancelled');
    expect(normalizeInviteStatus({ status: 'canceled' })).toBe('cancelled');
    expect(normalizeInviteStatus({ status: 'pending' })).toBe('pending');
    expect(normalizeInviteStatus({ status: 'expired' })).toBe('expired');
    expect(normalizeInviteStatus({ status: 'accepted' })).toBe('accepted');
    expect(normalizeInviteStatus({ status: 'failed' })).toBe('failed');
    expect(normalizeInviteStatus({ status: 2 })).toBe('pending');
  });

  test('treats unknown numeric and string statuses as unknown-active', () => {
    expect(normalizeInviteStatus({ status: 9 })).toBe('unknown-active');
    expect(normalizeInviteStatus({ status: 'mystery-state' })).toBe('unknown-active');
    expect(normalizeInviteStatus({ status: null })).toBe('unknown-active');
  });
});

describe('invite selection helpers', () => {
  test('findInviteByEmail reuses only pending invites for the requested email', () => {
    const pendingInvite = { id: 'invite-pending', email: 'member@example.com', status: 2 };

    expect(findInviteByEmail([pendingInvite], 'member@example.com')).toEqual(pendingInvite);
    expect(findInviteByEmail([{ id: 'invite-accepted', email_address: 'member@example.com', status: 'accepted' }], 'member@example.com')).toBeNull();
    expect(findInviteByEmail([{ id: 'invite-expired', email_address: 'member@example.com', status: 'expired' }], 'member@example.com')).toBeNull();
    expect(findInviteByEmail([{ id: 'invite-cancelled', email_address: 'member@example.com', status: 'cancelled' }], 'member@example.com')).toBeNull();
    expect(findInviteByEmail([{ id: 'invite-failed', email_address: 'member@example.com', status: 'failed' }], 'member@example.com')).toBeNull();
    expect(findInviteByEmail([{ id: 'invite-unknown', email_address: 'member@example.com', status: 9 }], 'member@example.com')).toBeNull();
  });

  test('selectOldestPrunableInvite considers only definitely pending invites', () => {
    const invites = [
      { id: 'invite-terminal-oldest', email_address: 'terminal@example.com', created_time: '2026-03-28T18:00:00.000Z', status: 'accepted' },
      { id: 'invite-pending-newer', email_address: 'pending-newer@example.com', created_time: '2026-03-28T20:00:00.000Z', status: 'pending' },
      { id: 'invite-unknown-mid', email_address: 'unknown@example.com', created_time: '2026-03-28T19:00:00.000Z', status: 9 },
      { id: 'invite-pending-oldest', email_address: 'pending-oldest@example.com', created_time: '2026-03-28T17:00:00.000Z', status: 2 },
    ];

    expect(selectOldestPrunableInvite(invites)).toEqual(expect.objectContaining({ id: 'invite-pending-oldest' }));
    expect(selectOldestPrunableInvite(invites, { excludeEmail: 'pending-oldest@example.com' })).toEqual(expect.objectContaining({ id: 'invite-pending-newer' }));
  });
});

describe('ensureWorkspaceInvite', () => {
  test('reuses an existing invite for the same email without cancelling or recreating it', async () => {
    const listInvites = jest.fn().mockResolvedValue({
      items: [
        { id: 'invite-existing', email_address: 'member@example.com', created_time: '2026-03-28T20:00:00.000Z', status: 2 },
      ],
    });
    const createInvite = jest.fn();
    const cancelInvite = jest.fn();

    const result = await ensureWorkspaceInvite({
      workspaceId: 'workspace-123',
      email: 'member@example.com',
      listInvites,
      createInvite,
      cancelInvite,
    });

    expect(result).toEqual(expect.objectContaining({
      action: 'reused-existing',
      invite: expect.objectContaining({ id: 'invite-existing' }),
      attempts: 0,
    }));
    expect(createInvite).not.toHaveBeenCalled();
    expect(cancelInvite).not.toHaveBeenCalled();
  });

  test('prunes the oldest other invite and retries only when createInvite explicitly errors for the target email', async () => {
    const listInvites = jest.fn()
      .mockResolvedValueOnce({
        items: [
          { id: 'invite-oldest', email_address: 'oldest@example.com', created_time: '2026-03-28T19:00:00.000Z', status: 2 },
          { id: 'invite-newer', email_address: 'newer@example.com', created_time: '2026-03-28T20:00:00.000Z', status: 'pending' },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          { id: 'invite-oldest', email_address: 'oldest@example.com', created_time: '2026-03-28T19:00:00.000Z', status: 2 },
          { id: 'invite-newer', email_address: 'newer@example.com', created_time: '2026-03-28T20:00:00.000Z', status: 'pending' },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          { id: 'invite-newer', email_address: 'newer@example.com', created_time: '2026-03-28T20:00:00.000Z', status: 'pending' },
        ],
      });
    const createInvite = jest.fn()
      .mockResolvedValueOnce({
        account_invites: [],
        errored_emails: [{ email: 'member@example.com', error: 'Unable to invite user due to an error.' }],
      })
      .mockResolvedValueOnce({
        account_invites: [{ id: 'invite-created', email: 'member@example.com', status: 'pending' }],
        errored_emails: [],
      });
    const cancelInvite = jest.fn().mockResolvedValue({ ok: true });

    const result = await ensureWorkspaceInvite({
      workspaceId: 'workspace-123',
      email: 'member@example.com',
      listInvites,
      createInvite,
      cancelInvite,
    });

    expect(cancelInvite).toHaveBeenCalledWith('workspace-123', 'invite-oldest');
    expect(createInvite).toHaveBeenCalledTimes(2);
    expect(result).toEqual(expect.objectContaining({
      action: 'pruned-and-created',
      prunedInvite: expect.objectContaining({ id: 'invite-oldest' }),
      createdInvite: expect.objectContaining({
        account_invites: [expect.objectContaining({ id: 'invite-created' })],
      }),
    }));
  });

  test('does not count a cancel response as pruning when the invite remains active after relist', async () => {
    const listInvites = jest.fn()
      .mockResolvedValueOnce({ items: [{ id: 'invite-stuck', email_address: 'old@example.com', created_time: '2026-03-28T19:00:00.000Z', status: 2 }] })
      .mockResolvedValueOnce({ items: [{ id: 'invite-stuck', email_address: 'old@example.com', created_time: '2026-03-28T19:00:00.000Z', status: 2 }] })
      .mockResolvedValueOnce({ items: [{ id: 'invite-stuck', email_address: 'old@example.com', created_time: '2026-03-28T19:00:00.000Z', status: 2 }] });
    const createInvite = jest.fn().mockResolvedValue({
      account_invites: [],
      errored_emails: [{ email_address: 'member@example.com', error: 'Unable to invite user due to an error.' }],
    });
    const cancelInvite = jest.fn().mockResolvedValue({ success: true });

    const result = await ensureWorkspaceInvite({
      workspaceId: 'workspace-123',
      email: 'member@example.com',
      listInvites,
      createInvite,
      cancelInvite,
      maxCreateAttempts: 1,
    });

    expect(cancelInvite).toHaveBeenCalledWith('workspace-123', 'invite-stuck');
    expect(result).toEqual(expect.objectContaining({
      action: 'create-errored',
      prunedInvite: null,
      failedPrunes: ['invite-stuck'],
    }));
  });

  test('does not count a cancel response as pruning when verification relist fails', async () => {
    const listInvites = jest.fn()
      .mockResolvedValueOnce({ items: [{ id: 'invite-stuck', email_address: 'old@example.com', created_time: '2026-03-28T19:00:00.000Z', status: 'pending' }] })
      .mockResolvedValueOnce({ items: [{ id: 'invite-stuck', email_address: 'old@example.com', created_time: '2026-03-28T19:00:00.000Z', status: 'pending' }] })
      .mockRejectedValueOnce(new Error('relist failed'));
    const createInvite = jest.fn().mockResolvedValue({
      account_invites: [],
      errored_emails: [{ email_address: 'member@example.com', error: 'Unable to invite user due to an error.' }],
    });
    const cancelInvite = jest.fn().mockResolvedValue({ success: true });

    const result = await ensureWorkspaceInvite({
      workspaceId: 'workspace-123',
      email: 'member@example.com',
      listInvites,
      createInvite,
      cancelInvite,
      maxCreateAttempts: 1,
    });

    expect(result).toEqual(expect.objectContaining({
      action: 'create-errored',
      prunedInvite: null,
      failedPrunes: ['invite-stuck'],
    }));
  });
});
