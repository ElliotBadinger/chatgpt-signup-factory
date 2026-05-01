import { describe, test, expect } from '@jest/globals';

import { buildOnboardRequest } from '../../src/cli/router-onboard-inboxes.js';

describe('buildOnboardRequest', () => {
  test('threads pool placement metadata and pool path into onboarding requests', () => {
    const request = buildOnboardRequest({
      email: 'member@example.com',
      entry: {
        rootApiKey: 'am_us_test',
        rootEmail: 'root-a@example.com',
        rootOrgId: 'org-a',
        lineage: 'lineage-a',
        workspaceId: 'workspace-lineage-a-2',
        workspaceName: 'Workspace A2',
        workspaceGroupKey: 'lineage-a',
        ownerAliasId: 'workspace-owner-a',
        ownerEmail: 'root-a@example.com',
      },
      poolPath: '/tmp/codex-inbox-pool.json',
      authJsonPath: '/tmp/auth.json',
      routerJsonPath: '/tmp/router.json',
      log: () => {},
    });

    expect(request).toEqual(expect.objectContaining({
      email: 'member@example.com',
      apiKey: 'am_us_test',
      poolPath: '/tmp/codex-inbox-pool.json',
      placementContext: expect.objectContaining({
        source: 'router-onboard-inboxes',
        rootEmail: 'root-a@example.com',
        rootOrgId: 'org-a',
        lineage: 'lineage-a',
        workspaceId: 'workspace-lineage-a-2',
        workspaceName: 'Workspace A2',
        workspaceGroupKey: 'lineage-a',
        ownerAliasId: 'workspace-owner-a',
        ownerEmail: 'root-a@example.com',
      }),
    }));
  });
});