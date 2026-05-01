import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '../../src/cli/pipeline-check-archive-replace.js');
const CANONICAL_PRODUCTION_WORKSPACE_ID = 'd3d588b2-8a74-4acc-aa2e-94662ff0e025';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-owner-admin-seat-hygiene-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedSeatHygieneFiles() {
  const archivePath = path.join(tmpDir, 'archive.json');
  const poolPath = path.join(tmpDir, 'pool.json');
  const healthPath = path.join(tmpDir, 'health.json');
  const routerPath = path.join(tmpDir, 'router.json');
  const authPath = path.join(tmpDir, 'auth.json');
  const registryPath = path.join(tmpDir, 'registry.json');
  const usersPath = path.join(tmpDir, 'workspace-users.json');
  const codexLbStorePath = path.join(tmpDir, 'codex-lb.db');

  fs.writeFileSync(archivePath, JSON.stringify({ version: 1, aliases: [] }));
  fs.writeFileSync(poolPath, JSON.stringify({
    version: 1,
    entries: [
      {
        inboxAddress: 'failed-append@agentmail.to',
        status: 'failed',
        lineage: 'lineage-a',
        workspaceId: CANONICAL_PRODUCTION_WORKSPACE_ID,
        workspaceName: 'Canonical Workspace',
        rootOrgId: CANONICAL_PRODUCTION_WORKSPACE_ID,
        ownerAliasId: 'owner-a',
      },
    ],
    lastCheckedAt: 0,
    allEntriesExhausted: false,
  }));
  fs.writeFileSync(healthPath, JSON.stringify({
    version: 1,
    providers: {
      aliasA: { status: 'cooldown' },
    },
    models: {},
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
        lineage: 'lineage-a',
        placementContext: {
          aliasId: 'aliasA',
          aliasEmail: 'aliasA@agentmail.to',
          lineage: 'lineage-a',
          workspaceId: CANONICAL_PRODUCTION_WORKSPACE_ID,
          workspaceMembership: true,
          ownerAliasId: 'owner-a',
        },
      },
    ],
    pools: [{ name: 'openai-codex', providers: ['aliasA'], routes: [] }],
    policy: {},
  }));
  fs.writeFileSync(authPath, JSON.stringify({
    aliasA: { access: 'tok-a', expires: Date.now() + 60_000, accountId: CANONICAL_PRODUCTION_WORKSPACE_ID },
  }));
  fs.writeFileSync(registryPath, JSON.stringify({
    discoveredAt: Date.now(),
    workspaces: [{
      workspaceId: CANONICAL_PRODUCTION_WORKSPACE_ID,
      workspaceName: 'Canonical Workspace',
      lineage: 'lineage-a',
      ownerAliasId: 'owner-a',
      ownerEmail: 'owner-a@example.com',
      ownerAccountId: CANONICAL_PRODUCTION_WORKSPACE_ID,
      healthyAccounts: 0,
      currentMembers: 8,
      maxMembers: 8,
    }],
  }));
  fs.writeFileSync(usersPath, JSON.stringify({
    [CANONICAL_PRODUCTION_WORKSPACE_ID]: {
      items: [
        { id: 'u-alias', email: 'aliasA@agentmail.to', role: 'standard-user' },
        { id: 'u-failed', email: 'failed-append@agentmail.to', role: 'standard-user' },
      ],
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
VALUES ('aliasA@agentmail.to', 'active', '${CANONICAL_PRODUCTION_WORKSPACE_ID}', 'aliasA', 'active');
`], { encoding: 'utf8' });

  return {
    archivePath,
    poolPath,
    healthPath,
    routerPath,
    authPath,
    registryPath,
    usersPath,
    codexLbStorePath,
  };
}

function runCliWithSeatHygiene(files, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, ['--experimental-vm-modules', CLI, ...args,
    '--archive-path', files.archivePath,
    '--pool-path', files.poolPath,
    '--health-path', files.healthPath,
    '--router-path', files.routerPath,
    '--auth-path', files.authPath,
  ], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      TARGET_WORKSPACE_ID: CANONICAL_PRODUCTION_WORKSPACE_ID,
      PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_REGISTRY_PATH: files.registryPath,
      PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_WORKSPACE_USERS_PATH: files.usersPath,
      PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_CODEX_LB_STORE_PATH: files.codexLbStorePath,
      PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_EXIT_AFTER_PRE_REMOVE: '1',
      ...extraEnv,
    },
  });
}

describe('pipeline-check-archive-replace owner-admin seat hygiene', () => {
  test('fails closed in dry-run when owner-admin seat hygiene scrub targets exist', () => {
    const files = seedSeatHygieneFiles();

    const result = runCliWithSeatHygiene(files, ['--dry-run']);

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/owner-admin seat hygiene required before append-only rerun/i);
    expect(result.stderr + result.stdout).toMatch(/failed-append@agentmail\.to:partially-materialized-workspace-member/);
    expect(result.stdout).not.toMatch(/Test exit after pre-remove/);
  });

  test('scrubs safe failed append-only workspace members before rerun and reopens seat capacity', () => {
    const files = seedSeatHygieneFiles();

    const result = runCliWithSeatHygiene(files);

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Owner-admin seat hygiene targeting 1 failed workspace member/);
    expect(result.stdout + result.stderr).toMatch(/Pre-removing 1 exhausted workspace member/);
    expect(result.stdout + result.stderr).toMatch(/Owner-admin scrubbed failed-append@agentmail\.to from/);
    expect(result.stdout + result.stderr).toMatch(/Test exit after pre-remove/);
    expect(result.stdout + result.stderr).not.toMatch(/workspace-seat-cap-reached/);
  });
});