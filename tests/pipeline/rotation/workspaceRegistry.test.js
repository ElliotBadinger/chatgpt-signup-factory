import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { discoverWorkspaceRegistry } from '../../../src/pipeline/rotation/workspaceRegistry.js';

let tmpDir;
let authPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-registry-'));
  authPath = path.join(tmpDir, 'auth.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('discoverWorkspaceRegistry', () => {
  test('multiple owner auth entries produce multiple discovered workspace records with no hardcoded workspace IDs', async () => {
    fs.writeFileSync(authPath, JSON.stringify({
      ownerA: {
        email: 'owner-a@example.com',
        access: 'tok-a',
        expires: Date.now() + 60_000,
        accountId: 'personal-a',
        lineage: 'lineage-a',
      },
      ownerB: {
        email: 'owner-b@example.com',
        access: 'tok-b',
        expires: Date.now() + 60_000,
        accountId: 'personal-b',
        lineage: 'lineage-b',
      },
      expiredOwner: {
        email: 'owner-c@example.com',
        access: 'tok-c',
        expires: Date.now() - 60_000,
        accountId: 'personal-c',
        lineage: 'lineage-c',
      },
    }, null, 2));

    const listWorkspacesForOwner = jest.fn(async ({ ownerAliasId }) => {
      if (ownerAliasId === 'ownerA') {
        return [
          { workspaceId: 'workspace-a-1', workspaceName: 'Alpha One', currentMembers: 3, maxMembers: 8 },
        ];
      }
      if (ownerAliasId === 'ownerB') {
        return [
          { workspaceId: 'workspace-b-1', workspaceName: 'Beta One', currentMembers: 5, maxMembers: 8 },
          { workspaceId: 'workspace-b-2', workspaceName: 'Beta Two', currentMembers: 2, maxMembers: 8 },
        ];
      }
      return [];
    });

    const registry = await discoverWorkspaceRegistry({
      authPath,
      listWorkspacesForOwner,
    });

    expect(listWorkspacesForOwner).toHaveBeenCalledTimes(2);
    expect(registry.owners.map((owner) => owner.ownerAliasId)).toEqual(['ownerA', 'ownerB']);
    expect(registry.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      'workspace-a-1',
      'workspace-b-1',
      'workspace-b-2',
    ]);
    expect(registry.workspaces.find((workspace) => workspace.workspaceId === 'workspace-b-2')).toEqual(expect.objectContaining({
      ownerAliasId: 'ownerB',
      ownerEmail: 'owner-b@example.com',
      lineage: 'lineage-b',
    }));
  });
});
