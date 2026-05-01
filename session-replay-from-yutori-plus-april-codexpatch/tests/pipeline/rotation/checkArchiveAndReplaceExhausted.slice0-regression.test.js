import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createCodexLbLifecycleStore } from '../../../src/pipeline/rotation/codexLbLifecycleStore.js';
import { repairCodexLbLifecycleDisagreements } from '../../../src/pipeline/rotation/checkArchiveAndReplaceExhausted.js';

describe('Slice 0 regression: repair evidence reads raw live probe facts', () => {
  test('repairs from minimal verified-probe evidence when raw live.ok is present', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice0-repair-regression-'));
    try {
      const storePath = path.join(tmpDir, 'store.db');
      const result = spawnSync('sqlite3', [storePath, `
CREATE TABLE accounts (
  email TEXT PRIMARY KEY,
  status TEXT,
  chatgpt_account_id TEXT,
  alias_id TEXT,
  lifecycle_state TEXT
);
INSERT INTO accounts (email, status, chatgpt_account_id, alias_id, lifecycle_state)
VALUES
  ('alias1@agentmail.to', 'deactivated', 'workspace-123', 'alias1', 'deactivated');
`], { encoding: 'utf8' });
      expect(result.status).toBe(0);

      const codexLbStore = createCodexLbLifecycleStore({ storePath });
      const auditedAliases = [{
        aliasId: 'alias1',
        email: 'alias1@agentmail.to',
        workspaceId: 'workspace-123',
        evidence: {
          auth: {
            accountId: 'workspace-123',
            hasRefresh: true,
          },
        },
        live: {
          ok: true,
          workspaceId: 'workspace-123',
          workspaceAccountSelected: true,
          sessionValid: true,
        },
        parentAgreement: {
          ok: true,
          reason: null,
        },
        codexLb: {
          email: 'alias1@agentmail.to',
          aliasId: 'alias1',
          workspaceId: 'workspace-123',
          lifecycleState: 'deactivated',
          status: 'deactivated',
        },
        codexLbAgreement: {
          ok: false,
          reason: 'store-disagreement',
        },
      }];

      const repaired = await repairCodexLbLifecycleDisagreements({
        auditedAliases,
        codexLbStore,
        targetWorkspaceId: 'workspace-123',
        detailLog: [],
      });

      expect(repaired.repairedAliases).toEqual(['alias1']);
      expect(repaired.disagreementDetails).toEqual([]);

      const rows = spawnSync('sqlite3', ['-json', storePath, "SELECT email, status, lifecycle_state FROM accounts WHERE email = 'alias1@agentmail.to';"], { encoding: 'utf8' });
      expect(rows.status).toBe(0);
      expect(JSON.parse(rows.stdout.trim())).toEqual([
        expect.objectContaining({
          email: 'alias1@agentmail.to',
          status: 'active',
          lifecycle_state: 'active',
        }),
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});