import { describe, test, expect, jest } from '@jest/globals';

import { ensureWorkspaceInvite } from '../../../src/pipeline/rotation/browserlessInvitePolicy.js';

describe('ensureWorkspaceInvite', () => {
  test('reuses an existing invite for the same email without cancelling or recreating it', async () => {
    const listInvites = jest.fn().mockResolvedValue({
      items: [
        { id: 'invite-existing', email_address: 'member@example.com', created_time: '2026-03-28T20:00:00.000Z' },
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
          { id: 'invite-oldest', email_address: 'oldest@example.com', created_time: '2026-03-28T19:00:00.000Z' },
          { id: 'invite-newer', email_address: 'newer@example.com', created_time: '2026-03-28T20:00:00.000Z' },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          { id: 'invite-oldest', email_address: 'oldest@example.com', created_time: '2026-03-28T19:00:00.000Z' },
          { id: 'invite-newer', email_address: 'newer@example.com', created_time: '2026-03-28T20:00:00.000Z' },
        ],
      });
    const createInvite = jest.fn()
      .mockResolvedValueOnce({
        account_invites: [],
        errored_emails: [{ email_address: 'member@example.com', error: 'Unable to invite user due to an error.' }],
      })
      .mockResolvedValueOnce({
        account_invites: [{ id: 'invite-created', email_address: 'member@example.com' }],
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
});