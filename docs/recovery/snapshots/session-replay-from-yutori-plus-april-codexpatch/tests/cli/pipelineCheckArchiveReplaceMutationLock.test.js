import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireFleetMutationLock } from '../../src/pipeline/rotation/unattendedMutationLock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '../../src/cli/pipeline-check-archive-replace.js');
const CANONICAL_PRODUCTION_WORKSPACE_ID = 'd3d588b2-8a74-4acc-aa2e-94662ff0e025';
const CANONICAL_PARENT_ALIAS_ID = 'workspace-owner-a';
const CANONICAL_PARENT_LINEAGE = 'workspace-owner-a';
const CANONICAL_PARENT_ROOT_EMAIL = 'agentmailroot1773504739a@epistemophile.space';

let tmpDir;
const heldLocks = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mutation-lock-'));
});

afterEach(async () => {
  while (heldLocks.length > 0) {
    const lock = heldLocks.pop();
    await lock.release();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedCanonicalMutationFiles() {
  const archivePath = path.join(tmpDir, 'archive.json');
  const poolPath = path.join(tmpDir, 'pool.json');
  const healthPath = path.join(tmpDir, 'health.json');
  const routerPath = path.join(tmpDir, 'router.json');
  const authPath = path.join(tmpDir, 'auth.json');
  const registryPath = path.join(tmpDir, 'registry.json');
  const codexLbStorePath = path.join(tmpDir, 'codex-lb.db');
  const controlPlanePath = path.join(tmpDir, 'agentmail-control-plane.json');

  fs.writeFileSync(archivePath, JSON.stringify({ version: 1, aliases: [] }));
  fs.writeFileSync(poolPath, JSON.stringify({
    version: 1,
    entries: [
      {
        linkedAliasId: 'aliasA',
        inboxAddress: 'standby-a@agentmail.to',
        rootEmail: CANONICAL_PARENT_ROOT_EMAIL,
        rootOrgId: CANONICAL_PRODUCTION_WORKSPACE_ID,
        workspaceGroupKey: CANONICAL_PARENT_LINEAGE,
        lineage: CANONICAL_PARENT_LINEAGE,
        ownerAliasId: CANONICAL_PARENT_ALIAS_ID,
        rootApiKeyPrefix: 'am_',
        cfRuleId: 'r1',
        cfKvNamespaceId: 'kv1',
        status: 'available',
        statusUpdatedAt: Date.now(),
      },
      {
        linkedAliasId: 'aliasB',
        inboxAddress: 'standby-b@agentmail.to',
        rootEmail: CANONICAL_PARENT_ROOT_EMAIL,
        rootOrgId: CANONICAL_PRODUCTION_WORKSPACE_ID,
        workspaceGroupKey: CANONICAL_PARENT_LINEAGE,
        lineage: CANONICAL_PARENT_LINEAGE,
        ownerAliasId: CANONICAL_PARENT_ALIAS_ID,
        rootApiKeyPrefix: 'am_',
        cfRuleId: 'r2',
        cfKvNamespaceId: 'kv2',
        status: 'available',
        statusUpdatedAt: Date.now(),
      },
    ],
    lastCheckedAt: 0,
    allEntriesExhausted: false,
  }));
  fs.writeFileSync(healthPath, JSON.stringify({
    version: 1,
    providers: {},
    models: {
      'aliasA/gpt-5.4': { quotaRemainingFraction: 0.0, quotaCheckedAt: Date.now(), quotaProofAmbiguous: false },
      'aliasB/gpt-5.4': { quotaRemainingFraction: 0.8, quotaCheckedAt: Date.now(), quotaProofAmbiguous: false },
    },
  }));
  fs.writeFileSync(routerPath, JSON.stringify({
    version: 1,
    aliases: [
      {
        id: 'aliasA',
        cloneFrom: 'openai-codex',
        email: 'aliasA@agentmail.to',
        label: 'aliasA',
        disabled: false,
        lineage: CANONICAL_PARENT_LINEAGE,
        workspaceId: CANONICAL_PRODUCTION_WORKSPACE_ID,
      },
      {
        id: 'aliasB',
        cloneFrom: 'openai-codex',
        email: 'aliasB@agentmail.to',
        label: 'aliasB',
        disabled: false,
        lineage: CANONICAL_PARENT_LINEAGE,
        workspaceId: CANONICAL_PRODUCTION_WORKSPACE_ID,
      },
    ],
    pools: [{ name: 'openai-codex', providers: ['aliasA', 'aliasB'], routes: [] }],
    policy: {},
  }));
  fs.writeFileSync(authPath, JSON.stringify({
    aliasA: { access: 'tok-a', refresh: 'ref-a', expires: Date.now() + 60_000, accountId: CANONICAL_PRODUCTION_WORKSPACE_ID },
    aliasB: { access: 'tok-b', refresh: 'ref-b', expires: Date.now() + 60_000, accountId: CANONICAL_PRODUCTION_WORKSPACE_ID },
  }));
  fs.writeFileSync(registryPath, JSON.stringify({
    discoveredAt: Date.now(),
    owners: [{ ownerAliasId: CANONICAL_PARENT_ALIAS_ID, ownerEmail: 'owner-a@example.com', ownerAccountId: CANONICAL_PRODUCTION_WORKSPACE_ID, lineage: CANONICAL_PARENT_LINEAGE }],
    workspaces: [{
      workspaceId: CANONICAL_PRODUCTION_WORKSPACE_ID,
      workspaceName: 'Root-Mail_a',
      ownerAliasId: CANONICAL_PARENT_ALIAS_ID,
      ownerEmail: 'owner-a@example.com',
      ownerAccountId: CANONICAL_PRODUCTION_WORKSPACE_ID,
      lineage: CANONICAL_PARENT_LINEAGE,
      currentMembers: 4,
      maxMembers: 8,
      healthyAccounts: 4,
      provenOwnerCapable: true,
      lastVerifiedAt: Date.now(),
      usable: true,
      eligible: true,
      deactivated: false,
      eligibilityStatus: 'usable',
    }],
    observedWorkspaces: [],
    usableByLineage: {},
  }));
  fs.writeFileSync(controlPlanePath, JSON.stringify({
    version: 1,
    workspaces: {
      [CANONICAL_PRODUCTION_WORKSPACE_ID]: {
        workspaceId: CANONICAL_PRODUCTION_WORKSPACE_ID,
        workspaceName: 'Root-Mail_a',
        ownerAliasId: CANONICAL_PARENT_ALIAS_ID,
        ownerEmail: 'owner-a@example.com',
        lineage: CANONICAL_PARENT_LINEAGE,
        preferredRootEmail: CANONICAL_PARENT_ROOT_EMAIL,
        preferredRootOrgId: CANONICAL_PRODUCTION_WORKSPACE_ID,
        organizations: [],
      },
    },
  }));

  spawnSync('sqlite3', [codexLbStorePath, `
CREATE TABLE accounts (
  email TEXT PRIMARY KEY,
  status TEXT,
  chatgpt_account_id TEXT,
  alias_id TEXT,
  lifecycle_state TEXT
);
INSERT INTO accounts (email, status, chatgpt_account_id, alias_id, lifecycle_state)
VALUES
  ('aliasA@agentmail.to', 'active', '${CANONICAL_PRODUCTION_WORKSPACE_ID}', 'aliasA', 'active'),
  ('aliasB@agentmail.to', 'active', '${CANONICAL_PRODUCTION_WORKSPACE_ID}', 'aliasB', 'active');
`], { encoding: 'utf8' });

  return {
    archivePath,
    poolPath,
    healthPath,
    routerPath,
    authPath,
    registryPath,
    codexLbStorePath,
    controlPlanePath,
  };
}

function seedRepairOnlyFiles() {
  const archivePath = path.join(tmpDir, 'archive.json');
  const poolPath = path.join(tmpDir, 'pool.json');
  const healthPath = path.join(tmpDir, 'health.json');
  const routerPath = path.join(tmpDir, 'router.json');
  const authPath = path.join(tmpDir, 'auth.json');
  const codexLbStorePath = path.join(tmpDir, 'codex-lb-repair.db');
  const controlPlanePath = path.join(tmpDir, 'agentmail-control-plane.json');

  fs.writeFileSync(archivePath, JSON.stringify({ version: 1, aliases: [] }));
  fs.writeFileSync(poolPath, JSON.stringify({
    version: 1,
    entries: [{
      linkedAliasId: 'alias1',
      inboxAddress: 'a@agentmail.to',
      rootEmail: 'root@example.com',
      rootOrgId: CANONICAL_PRODUCTION_WORKSPACE_ID,
      rootApiKeyPrefix: 'am_',
      cfRuleId: 'r1',
      cfKvNamespaceId: 'kv1',
      status: 'available',
      statusUpdatedAt: Date.now(),
    }],
    lastCheckedAt: 0,
    allEntriesExhausted: false,
  }));
  fs.writeFileSync(healthPath, JSON.stringify({
    version: 1,
    providers: {},
    models: {
      'alias1/gpt-5.4': { quotaRemainingFraction: 0.0, quotaCheckedAt: Date.now(), quotaProofAmbiguous: false },
    },
  }));
  fs.writeFileSync(routerPath, JSON.stringify({
    version: 1,
    aliases: [{
      id: 'alias1',
      cloneFrom: 'openai-codex',
      email: 'alias1@agentmail.to',
      label: 'alias1',
      disabled: false,
      placementContext: {
        aliasId: 'alias1',
        aliasEmail: 'alias1@agentmail.to',
        lineage: 'lineage-a',
        workspaceId: CANONICAL_PRODUCTION_WORKSPACE_ID,
        workspaceMembership: true,
      },
    }],
    pools: [{ name: 'openai-codex', providers: ['alias1'], routes: [{ provider: 'alias1', model: 'gpt-5.4' }] }],
    policy: {},
  }));
  fs.writeFileSync(authPath, JSON.stringify({
    alias1: {
      access: 'tok-a',
      refresh: 'ref-a',
      expires: Date.now() + 60_000,
      accountId: CANONICAL_PRODUCTION_WORKSPACE_ID,
    },
  }));
  fs.writeFileSync(controlPlanePath, JSON.stringify({
    version: 1,
    workspaces: {
      [CANONICAL_PRODUCTION_WORKSPACE_ID]: {
        workspaceId: CANONICAL_PRODUCTION_WORKSPACE_ID,
        workspaceName: 'Canonical Workspace',
        ownerAliasId: 'workspace-owner-a',
        ownerEmail: 'owner-a@example.com',
        lineage: 'lineage-a',
        preferredRootEmail: 'root@example.com',
        preferredRootOrgId: CANONICAL_PRODUCTION_WORKSPACE_ID,
        organizations: [],
      },
    },
  }));

  spawnSync('sqlite3', [codexLbStorePath, `
CREATE TABLE accounts (
  email TEXT PRIMARY KEY,
  status TEXT,
  chatgpt_account_id TEXT,
  alias_id TEXT,
  lifecycle_state TEXT
);
INSERT INTO accounts (email, status, chatgpt_account_id, alias_id, lifecycle_state)
VALUES ('alias1@agentmail.to', 'deactivated', '${CANONICAL_PRODUCTION_WORKSPACE_ID}', 'alias1', 'deactivated');
`], { encoding: 'utf8' });

  return {
    archivePath,
    poolPath,
    healthPath,
    routerPath,
    authPath,
    codexLbStorePath,
    controlPlanePath,
  };
}

describe('pipeline-check-archive-replace unattended mutation lock', () => {
  test('refuses the canonical unattended mutation path when the global fleet lock is already held', async () => {
    const files = seedCanonicalMutationFiles();
    const lockPath = path.join(tmpDir, 'fleet.lock');
    const heldLock = await acquireFleetMutationLock({
      owner: 'test-holder',
      lockPath,
      metadata: { entrypoint: 'test-canonical' },
    });
    heldLocks.push(heldLock);

    const result = spawnSync(process.execPath, ['--experimental-vm-modules', CLI,
      '--archive-path', files.archivePath,
      '--pool-path', files.poolPath,
      '--health-path', files.healthPath,
      '--router-path', files.routerPath,
      '--auth-path', files.authPath,
    ], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PIPELINE_UNATTENDED_MUTATION_LOCK_PATH: lockPath,
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_REGISTRY_PATH: files.registryPath,
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_TARGET_WORKSPACE_ID: CANONICAL_PRODUCTION_WORKSPACE_ID,
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_CODEX_LB_STORE_PATH: files.codexLbStorePath,
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_MODE: '1',
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_RUNTIME_PROBE_FIXTURES: JSON.stringify({
          aliasA: {
            me: { email: 'aliasA@agentmail.to' },
            accounts: { items: [{ id: CANONICAL_PRODUCTION_WORKSPACE_ID, structure: 'workspace' }] },
            consent: { is_consent_required: false },
            liveProbe: { ok: true, exitCode: 0, eventCount: 3 },
          },
          aliasB: {
            me: { email: 'aliasB@agentmail.to' },
            accounts: { items: [{ id: CANONICAL_PRODUCTION_WORKSPACE_ID, structure: 'workspace' }] },
            consent: { is_consent_required: false },
            liveProbe: { ok: true, exitCode: 0, eventCount: 3 },
          },
        }),
        AGENTMAIL_CONTROL_PLANE_PATH: files.controlPlanePath,
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_EXIT_AFTER_PRE_REMOVE: '1',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/Deep-interview fleet mutation lock is already held/i);
    expect(result.stdout + result.stderr).not.toMatch(/Test exit after pre-remove/);
  });

  test('refuses repair-only codex-lb mutation when the global fleet lock is already held', async () => {
    const files = seedRepairOnlyFiles();
    const lockPath = path.join(tmpDir, 'fleet.lock');
    const heldLock = await acquireFleetMutationLock({
      owner: 'test-holder',
      lockPath,
      metadata: { entrypoint: 'test-repair-only' },
    });
    heldLocks.push(heldLock);

    const result = spawnSync(process.execPath, ['--experimental-vm-modules', CLI,
      '--repair-codex-lb-only',
      '--archive-path', files.archivePath,
      '--pool-path', files.poolPath,
      '--health-path', files.healthPath,
      '--router-path', files.routerPath,
      '--auth-path', files.authPath,
    ], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PIPELINE_UNATTENDED_MUTATION_LOCK_PATH: lockPath,
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_CODEX_LB_STORE_PATH: files.codexLbStorePath,
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_MODE: '1',
        PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_RUNTIME_PROBE_FIXTURES: JSON.stringify({
          alias1: {
            me: { email: 'alias1@agentmail.to' },
            accounts: { items: [{ id: CANONICAL_PRODUCTION_WORKSPACE_ID, structure: 'workspace' }] },
            consent: { is_consent_required: false },
            liveProbe: { ok: true, exitCode: 0, eventCount: 3 },
          },
        }),
        AGENTMAIL_CONTROL_PLANE_PATH: files.controlPlanePath,
        TARGET_WORKSPACE_ID: CANONICAL_PRODUCTION_WORKSPACE_ID,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/Deep-interview fleet mutation lock is already held/i);
    expect(result.stdout + result.stderr).not.toMatch(/Repair-only codex-lb mode complete/);
  });
});