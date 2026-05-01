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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-car-fresh-identity-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedFiles() {
  const archivePath = path.join(tmpDir, 'archive.json');
  const poolPath = path.join(tmpDir, 'pool.json');
  const healthPath = path.join(tmpDir, 'health.json');
  const routerPath = path.join(tmpDir, 'router.json');
  const authPath = path.join(tmpDir, 'auth.json');
  const registryPath = path.join(tmpDir, 'registry.json');
  const codexLbStorePath = path.join(tmpDir, 'codex-lb.db');

  fs.writeFileSync(archivePath, JSON.stringify({ version: 1, aliases: [] }));
  fs.writeFileSync(poolPath, JSON.stringify({
    version: 1,
    entries: [
      {
        inboxAddress: 'occupied@agentmail.to',
        status: 'in-use',
        workspaceId: CANONICAL_PRODUCTION_WORKSPACE_ID,
        rootOrgId: CANONICAL_PRODUCTION_WORKSPACE_ID,
        lineage: 'lineage-a',
        workspaceGroupKey: 'lineage-a',
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
      'aliasA/gpt-5.4': {
        quotaRemainingFraction: 0,
        quotaCheckedAt: Date.now(),
        quotaProofAmbiguous: false,
      },
    },
  }));
  fs.writeFileSync(routerPath, JSON.stringify({
    version: 1,
    aliases: [
      {
        id: 'aliasA',
        cloneFrom: 'openai-codex',
        email: 'aliasA@agentmail.to',
        disabled: false,
        placementContext: {
          aliasId: 'aliasA',
          aliasEmail: 'aliasA@agentmail.to',
          lineage: 'lineage-a',
          workspaceId: CANONICAL_PRODUCTION_WORKSPACE_ID,
          workspaceMembership: true,
        },
      },
    ],
    pools: [{ name: 'openai-codex', providers: ['aliasA'], routes: [] }],
    policy: {},
  }));
  fs.writeFileSync(authPath, JSON.stringify({
    aliasA: {
      access: 'tok-a',
      expires: Date.now() + 60_000,
      accountId: CANONICAL_PRODUCTION_WORKSPACE_ID,
    },
  }));
  fs.writeFileSync(registryPath, JSON.stringify({
    discoveredAt: Date.now(),
    workspaces: [
      {
        workspaceId: CANONICAL_PRODUCTION_WORKSPACE_ID,
        workspaceName: 'Canonical Workspace',
        lineage: 'lineage-a',
        ownerAliasId: 'owner-a',
        ownerEmail: 'owner-a@example.com',
        healthyAccounts: 3,
        currentMembers: 2,
        maxMembers: 8,
        provenOwnerCapable: true,
        ownerRole: 'account-owner',
        verificationSource: 'workspace-list-users',
        lastVerifiedAt: new Date().toISOString(),
      },
    ],
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

  return { archivePath, poolPath, healthPath, routerPath, authPath, registryPath, codexLbStorePath };
}

function readPreflightSummaryArtifact(stdout) {
  const canonicalMatch = stdout.match(/\[check-archive-replace\] canonicalRunArtifactPath=(.*)/);
  expect(canonicalMatch).toBeTruthy();
  const canonicalArtifactPath = canonicalMatch[1].trim();
  const summaryPath = path.join(path.dirname(canonicalArtifactPath), 'summary.json');
  return JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
}

describe('pipeline-check-archive-replace canonical fresh identity blocker artifact', () => {
  test('surfaces fresh-identity-unavailable in canonical blocker artifacts when AgentMail capacity is exhausted', () => {
    const { archivePath, poolPath, healthPath, routerPath, authPath, registryPath, codexLbStorePath } = seedFiles();
    const result = spawnSync(
      process.execPath,
      ['--experimental-vm-modules', CLI,
        '--dry-run',
        '--archive-path', archivePath,
        '--pool-path', poolPath,
        '--health-path', healthPath,
        '--router-path', routerPath,
        '--auth-path', authPath],
      {
        encoding: 'utf8',
        timeout: 15_000,
        cwd: tmpDir,
        env: {
          ...process.env,
          TARGET_WORKSPACE_ID: CANONICAL_PRODUCTION_WORKSPACE_ID,
          PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_MODE: '1',
          PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_REGISTRY_PATH: registryPath,
          PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_CODEX_LB_STORE_PATH: codexLbStorePath,
          PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_RUNTIME_PROBE_FIXTURES: JSON.stringify({
            aliasA: {
              me: { email: 'aliasA@agentmail.to' },
              accounts: { items: [{ id: CANONICAL_PRODUCTION_WORKSPACE_ID, structure: 'workspace' }] },
              consent: { is_consent_required: false },
              liveProbe: { ok: true, exitCode: 0, eventCount: 2 },
            },
          }),
          PIPELINE_CHECK_ARCHIVE_REPLACE_TEST_FRESH_IDENTITY_RESULT: JSON.stringify({
            status: 'fresh-identity-unavailable',
            blockerReason: 'fresh-identity-unavailable',
            reason: 'agentmail-inbox-capacity-exhausted',
            error: 'LimitExceededError: inbox capacity exhausted',
            freshIdentity: {
              required: true,
              acquired: false,
              source: null,
              persisted: false,
              reason: 'agentmail-inbox-capacity-exhausted',
            },
          }),
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/fresh-identity-unavailable/);
    const artifact = readPreflightSummaryArtifact(result.stdout);
    expect(artifact.preflightVerdict.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'fresh-identity-unavailable',
        message: expect.stringContaining('agentmail-inbox-capacity-exhausted'),
      }),
    ]));
    expect(artifact.details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        blockerReason: 'fresh-identity-unavailable',
      }),
    ]));
    expect(artifact.preflightVerdict.blockers.find((blocker) => blocker.code === 'fresh-identity-unavailable')?.details?.freshIdentityResult).toEqual(expect.objectContaining({
      status: 'fresh-identity-unavailable',
      blockerReason: 'fresh-identity-unavailable',
      reason: 'agentmail-inbox-capacity-exhausted',
    }));
  });
});