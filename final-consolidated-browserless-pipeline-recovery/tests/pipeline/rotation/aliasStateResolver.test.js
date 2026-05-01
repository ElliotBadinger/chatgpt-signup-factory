import { describe, expect, test } from '@jest/globals';

import {
  findNextSafeAlias,
  resolveAliasStates,
} from '../../../src/pipeline/rotation/aliasStateResolver.js';

describe('resolveAliasStates', () => {
  test('classifies alias state across router, auth, archive, workspace, invites, and codex-lb inputs', () => {
    const resolved = resolveAliasStates({
      prefix: 'openai',
      domain: 'epistemophile.store',
      router: {
        aliases: [
          { id: 'openai_2', email: 'openai_2@epistemophile.store' },
          { id: 'openai_3', email: 'openai_3@epistemophile.store' },
        ],
      },
      auth: {
        openai_2: { access: 'tok-live' },
        openai_7: { access: 'tok-stale-shape' },
      },
      archive: {
        aliases: [
          { aliasId: 'openai_5', email: 'openai_5@epistemophile.store', reinstated: false },
          { aliasId: 'openai_9', email: 'openai_9@epistemophile.store', reinstated: true },
        ],
      },
      workspaceMembers: [
        { email: 'openai_4@epistemophile.store' },
      ],
      invites: {
        items: [
          { id: 'invite-8', email_address: 'openai_8@epistemophile.store', status: 2 },
          { id: 'invite-cancelled', email_address: 'openai_10@epistemophile.store', status: 'cancelled' },
        ],
      },
      codexLbAccounts: [
        { email: 'openai_6@epistemophile.store', accountId: 'workspace-6' },
        { email: 'openai_2@epistemophile.store', accountId: 'workspace-2' },
      ],
    });

    expect(resolved.byEmail).toEqual(expect.objectContaining({
      'openai_2@epistemophile.store': expect.objectContaining({
        aliasId: 'openai_2',
        state: 'usable',
        safeToAllocate: false,
      }),
      'openai_3@epistemophile.store': expect.objectContaining({
        aliasId: 'openai_3',
        state: 'router-only',
        safeToAllocate: false,
      }),
      'openai_4@epistemophile.store': expect.objectContaining({
        aliasId: 'openai_4',
        state: 'workspace-member-no-router',
        safeToAllocate: false,
      }),
      'openai_5@epistemophile.store': expect.objectContaining({
        aliasId: 'openai_5',
        state: 'archived',
        safeToAllocate: false,
      }),
      'openai_6@epistemophile.store': expect.objectContaining({
        aliasId: 'openai_6',
        state: 'codex-lb-only',
        safeToAllocate: false,
      }),
      'openai_7@epistemophile.store': expect.objectContaining({
        aliasId: 'openai_7',
        state: 'unknown-live-state',
        safeToAllocate: false,
      }),
      'openai_8@epistemophile.store': expect.objectContaining({
        aliasId: 'openai_8',
        state: 'pending-invite',
        safeToAllocate: false,
      }),
    }));

    expect(resolved.aliases.map((entry) => entry.aliasId)).toEqual([
      'openai_2',
      'openai_3',
      'openai_4',
      'openai_5',
      'openai_6',
      'openai_7',
      'openai_8',
    ]);
  });
});

describe('findNextSafeAlias', () => {
  test('returns the first safe alias candidate and treats reinstated archive entries as allocatable again', () => {
    const nextAlias = findNextSafeAlias({
      prefix: 'openai',
      domain: 'epistemophile.store',
      router: {
        aliases: [
          { id: 'openai_2', email: 'openai_2@epistemophile.store' },
          { id: 'openai_3', email: 'openai_3@epistemophile.store' },
        ],
      },
      auth: {
        openai_2: { access: 'tok-live' },
        openai_7: { access: 'tok-stale-shape' },
      },
      archive: {
        aliases: [
          { aliasId: 'openai_5', email: 'openai_5@epistemophile.store', reinstated: false },
          { aliasId: 'openai_9', email: 'openai_9@epistemophile.store', reinstated: true },
        ],
      },
      workspaceMembers: [
        { email: 'openai_4@epistemophile.store' },
      ],
      invites: [
        { id: 'invite-8', email_address: 'openai_8@epistemophile.store', status: 'pending' },
      ],
      codexLbAccounts: [
        { email: 'openai_6@epistemophile.store', accountId: 'workspace-6' },
      ],
    });

    expect(nextAlias).toEqual(expect.objectContaining({
      aliasId: 'openai_9',
      email: 'openai_9@epistemophile.store',
      state: 'safe-to-allocate',
      safeToAllocate: true,
    }));
  });

  test('does not let terminal invite rows block allocation', () => {
    const nextAlias = findNextSafeAlias({
      prefix: 'openai',
      domain: 'epistemophile.store',
      invites: [
        { id: 'invite-2', email_address: 'openai_2@epistemophile.store', status: 'accepted' },
        { id: 'invite-3', email_address: 'openai_3@epistemophile.store', status: 'expired' },
        { id: 'invite-4', email_address: 'openai_4@epistemophile.store', status: 'failed' },
        { id: 'invite-5', email_address: 'openai_5@epistemophile.store', status: 'cancelled' },
        { id: 'invite-6', email_address: 'openai_6@epistemophile.store', status: 'pending' },
      ],
    });

    expect(nextAlias).toEqual(expect.objectContaining({
      aliasId: 'openai_2',
      email: 'openai_2@epistemophile.store',
      state: 'safe-to-allocate',
      safeToAllocate: true,
    }));
  });
});
