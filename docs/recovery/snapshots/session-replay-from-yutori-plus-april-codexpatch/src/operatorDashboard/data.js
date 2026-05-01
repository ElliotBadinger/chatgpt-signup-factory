import path from 'node:path';
import os from 'node:os';
import { readFile, readdir } from 'node:fs/promises';
import fs from 'node:fs';

import { buildWorkspaceControlPlaneStatus, loadAgentMailControlPlane } from '../agentmail/controlPlane.js';
import { resolveRoutingDomain, resolveWorkspaceOwnerEmail } from '../pipeline/config/routingDomain.js';
import { createBrowserlessWorkspaceClient, isWorkspaceDeactivatedError } from '../pipeline/rotation/browserlessWorkspaceClient.js';
import { resolveExistingCodexLbStorePath } from '../pipeline/rotation/codexLbLifecycleStore.js';
import { collectLiveAuthorityFacts } from '../pipeline/rotation/liveAuthorityFacts.js';
import { hasRuntimeWorkspaceAccessProof } from '../pipeline/rotation/liveAuthorityHealth.js';
import { createRuntimeVerifiedAliasProbe } from '../pipeline/rotation/runtimeAliasProbe.js';
import { discoverOperationalWorkspaceRegistry } from '../pipeline/rotation/workspaceRegistry.js';

const CANONICAL_OPERATOR_SCRIPT = 'src/cli/pipeline-check-archive-replace.js';

async function loadJsonFile(filePath, fallbackValue) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return fallbackValue;
    }
    throw error;
  }
}

async function loadTextFile(filePath, fallbackValue = '') {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return fallbackValue;
    }
    throw error;
  }
}

async function findLatestCanonicalArtifactPath(worktreeRoot) {
  const runsDir = path.join(worktreeRoot, 'state', 'rotation', 'runs');
  try {
    const dirents = await readdir(runsDir, { withFileTypes: true });
    const candidates = dirents
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(runsDir, entry.name, 'canonical-run-artifact.json'))
      .filter((candidatePath) => fs.existsSync(candidatePath))
      .sort();
    return candidates.at(-1) ?? null;
  } catch {
    return null;
  }
}

async function findNearestEnvFile(startDir) {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidatePath = path.join(currentDir, '.env');
    try {
      await readFile(candidatePath, 'utf8');
      return candidatePath;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function parseDotEnv(content) {
  const result = {};

  for (const rawLine of String(content).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equalsIndex = line.indexOf('=');
    if (equalsIndex < 0) continue;
    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

function normalizeString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeEmail(value) {
  const text = normalizeString(value);
  return text ? text.toLowerCase() : null;
}

const REQUIRED_ENV_SPECS = [
  {
    key: 'AGENTMAIL_API_KEY',
    label: 'AgentMail API key',
    category: 'Canonical operator contract',
    description: 'Required for inbox creation and live onboarding side effects.',
    required: true,
  },
  {
    key: 'TARGET_WORKSPACE_ID',
    aliases: ['WORKSPACE_ID'],
    label: 'Target workspace id',
    category: 'Canonical operator contract',
    description: 'Production path requires an explicit target workspace id. WORKSPACE_ID remains a legacy alias.',
    required: true,
  },
  {
    key: 'WORKSPACE_NAME',
    label: 'Target workspace name',
    category: 'Workspace selection',
    description: 'Workspace display name used for operator context and workspace discovery fallbacks.',
    required: false,
    defaultValue: 'Root-Mail_a',
  },
  {
    key: 'WORKSPACE_OWNER_EMAIL',
    label: 'Preferred workspace owner email',
    category: 'Workspace selection',
    description: 'Optional explicit owner email; otherwise derived from live auth state.',
    required: false,
    derive: ({ auth, mergedEnv }) => {
      const resolved = resolveWorkspaceOwnerEmail({
        authData: auth,
        env: mergedEnv,
        nowMs: Date.now(),
      });
      return resolved
        ? { value: resolved, source: 'derived:live-auth' }
        : { value: '', source: 'missing' };
    },
  },
  {
    key: 'WORKSPACE_MAX_MEMBERS',
    label: 'Workspace member cap',
    category: 'Workspace selection',
    description: 'Soft seat-cap input used by live workspace discovery and rotation safety checks.',
    required: false,
    defaultValue: '8',
  },
  {
    key: 'AGENTMAIL_ROUTING_DOMAIN',
    aliases: ['AGENTMAIL_ROOT_DOMAIN', 'CLOUDFLARE_DOMAIN'],
    label: 'Routing domain',
    category: 'Root identity + routing',
    description: 'Primary routing domain. Falls back to derived owner domain or repository default when unset.',
    required: false,
    derive: ({ mergedEnv }) => ({
      value: resolveRoutingDomain(mergedEnv),
      source: 'derived:routing-domain',
    }),
  },
  {
    key: 'CLOUDFLARE_API_TOKEN',
    label: 'Cloudflare API token',
    category: 'Root identity + routing',
    description: 'Preferred Cloudflare credential for routing rules and OTP capture support.',
    required: false,
  },
  {
    key: 'CLOUDFLARE_GLOBAL_API_KEY',
    label: 'Cloudflare global API key',
    category: 'Root identity + routing',
    description: 'Legacy Cloudflare credential, used with CLOUDFLARE_EMAIL when token auth is unavailable.',
    required: false,
  },
  {
    key: 'CLOUDFLARE_EMAIL',
    label: 'Cloudflare auth email',
    category: 'Root identity + routing',
    description: 'Required only with the global API key flow.',
    required: false,
  },
  {
    key: 'CLOUDFLARE_ACCOUNT_ID',
    label: 'Cloudflare account id',
    category: 'Root identity + routing',
    description: 'Needed for KV-backed OTP recovery and related routing maintenance paths.',
    required: false,
  },
  {
    key: 'CLOUDFLARE_ZONE_ID',
    label: 'Cloudflare zone id',
    category: 'Root identity + routing',
    description: 'Needed for email routing rule maintenance.',
    required: false,
  },
  {
    key: 'AGENTMAIL_CONTROL_PLANE_PATH',
    label: 'AgentMail control-plane path override',
    category: 'Authority overrides',
    description: 'Optional path override for the shared AgentMail control-plane file.',
    required: false,
  },
  {
    key: 'CODEX_LB_STORE_PATH',
    label: 'codex-lb store path override',
    category: 'Authority overrides',
    description: 'Optional override for the codex-lb lifecycle store. If unset, the default existing store is used.',
    required: false,
  },
];

function resolveEnvVarValue({ spec, env, envFileValues, auth, mergedEnv, codexLbStorePath }) {
  const keys = [spec.key, ...(spec.aliases ?? [])];

  for (const key of keys) {
    if (env[key] !== undefined && env[key] !== '') {
      return { value: String(env[key]), source: key === spec.key ? 'process.env' : `process.env:${key}` };
    }
  }

  for (const key of keys) {
    if (envFileValues[key] !== undefined && envFileValues[key] !== '') {
      return { value: String(envFileValues[key]), source: key === spec.key ? '.env' : `.env:${key}` };
    }
  }

  if (spec.key === 'CODEX_LB_STORE_PATH' && codexLbStorePath) {
    return { value: String(codexLbStorePath), source: 'derived:codex-lb-store' };
  }

  if (typeof spec.derive === 'function') {
    const derived = spec.derive({ auth, env, envFileValues, mergedEnv, codexLbStorePath });
    if (derived?.value) {
      return { value: String(derived.value), source: derived.source ?? 'derived' };
    }
  }

  if (spec.defaultValue !== undefined) {
    return { value: String(spec.defaultValue), source: 'default' };
  }

  return { value: '', source: 'missing' };
}

function summarizePool(pool) {
  const entries = Array.isArray(pool?.entries) ? pool.entries : [];
  return {
    total: entries.length,
    available: entries.filter((entry) => entry?.status === 'available').length,
    inUse: entries.filter((entry) => entry?.status === 'in-use').length,
    failed: entries.filter((entry) => entry?.status === 'failed').length,
    chatGptUsed: entries.filter((entry) => entry?.status === 'chatgpt-used').length,
  };
}

function summarizeArchive(archive) {
  const aliases = Array.isArray(archive?.aliases) ? archive.aliases : [];
  return {
    archived: aliases.length,
    reinstated: aliases.filter((alias) => alias?.reinstated).length,
  };
}

function summarizeAuth(auth) {
  const aliasIds = Object.keys(auth ?? {});
  const now = Date.now();
  return {
    totalAliases: aliasIds.length,
    expiredAliases: aliasIds.filter((aliasId) => Number(auth[aliasId]?.expires ?? 0) > 0 && Number(auth[aliasId]?.expires ?? 0) <= now).length,
    aliases: aliasIds.map((aliasId) => ({
      aliasId,
      email: auth[aliasId]?.email ?? '',
      accountId: auth[aliasId]?.accountId ?? '',
      expires: auth[aliasId]?.expires ?? null,
      expired: Number(auth[aliasId]?.expires ?? 0) > 0 && Number(auth[aliasId]?.expires ?? 0) <= now,
    })),
  };
}

function summarizeWorkspaces(registry) {
  const workspaces = Array.isArray(registry?.workspaces) ? registry.workspaces : [];
  return {
    total: workspaces.length,
    items: workspaces.map((workspace) => ({
      workspaceId: workspace?.workspaceId ?? '',
      workspaceName: workspace?.workspaceName ?? '',
      ownerAliasId: workspace?.ownerAliasId ?? '',
      ownerEmail: workspace?.ownerEmail ?? '',
      ownerRole: workspace?.ownerRole ?? null,
      verificationSource: workspace?.verificationSource ?? null,
    })),
  };
}

function summarizeFrictionLedger(frictionLedger = {}) {
  const entries = Array.isArray(frictionLedger?.entries) ? frictionLedger.entries : [];
  return {
    total: entries.length,
    entries: entries
      .slice()
      .sort((left, right) => String(right.lastSeenAt ?? '').localeCompare(String(left.lastSeenAt ?? '')))
      .slice(0, 10),
  };
}

function buildArtifactLifecycleSummary({ canonicalArtifact }) {
  const itemsFromSnapshot = Array.isArray(canonicalArtifact?.lifecycleStates)
    ? canonicalArtifact.lifecycleStates
        .filter((entry) => entry?.aliasId && entry?.state)
        .map((entry) => ({ aliasId: entry.aliasId, state: entry.state }))
    : [];

  const items = itemsFromSnapshot.length > 0
    ? itemsFromSnapshot.sort((left, right) => left.aliasId.localeCompare(right.aliasId))
    : (() => {
        const stateByAliasId = new Map();
        for (const transition of canonicalArtifact?.lifecycleTransitions ?? []) {
          if (transition?.aliasId && transition?.toState) {
            stateByAliasId.set(transition.aliasId, transition.toState);
          }
        }
        return [...stateByAliasId.entries()]
          .map(([aliasId, state]) => ({ aliasId, state }))
          .sort((left, right) => left.aliasId.localeCompare(right.aliasId));
      })();

  const counts = items.reduce((acc, item) => {
    acc[item.state] = (acc[item.state] ?? 0) + 1;
    return acc;
  }, {});

  return {
    total: items.length,
    counts,
    items,
  };
}

function isLiveAuthorityHealthy(alias, codexLbStatus) {
  return deriveLiveAuthorityState(alias, codexLbStatus).status === 'healthy';
}

function deriveLiveAuthorityState(alias, codexLbStatus) {
  if (!alias?.authPresent) {
    return { status: 'auth-missing', lifecycleState: 'blocked' };
  }
  if (alias?.authDurable !== true) {
    return { status: 'auth-durability-missing', lifecycleState: 'blocked' };
  }
  if (alias?.parentAgreement?.ok === false) {
    return { status: 'parent-lineage-mismatch', lifecycleState: 'blocked' };
  }
  if (alias?.live == null) {
    return { status: 'runtime-unverified', lifecycleState: 'degraded' };
  }
  if (!hasRuntimeWorkspaceAccessProof(alias?.live)) {
    return { status: 'runtime-failed', lifecycleState: 'blocked' };
  }
  if (codexLbStatus?.ready !== true) {
    return { status: 'codex-lb-unverified', lifecycleState: 'degraded' };
  }
  if (alias?.codexLbAgreement?.ok === false) {
    return { status: 'codex-lb-disagreement', lifecycleState: 'blocked' };
  }
  return { status: 'healthy', lifecycleState: 'active' };
}

function deriveLiveAliasStatus(alias, codexLbStatus) {
  return deriveLiveAuthorityState(alias, codexLbStatus).status;
}

function summarizeRouterFromLiveFacts(liveAuthorityFacts = {}, health = {}) {
  const aliases = Array.isArray(liveAuthorityFacts?.aliases) ? liveAuthorityFacts.aliases : [];
  const codexLbStatus = liveAuthorityFacts?.codexLbStatus ?? { ready: false };
  const providerHealth = health?.providers && typeof health.providers === 'object' ? health.providers : {};

  return {
    totalAliases: aliases.length,
    healthyAliases: aliases.filter((alias) => isLiveAuthorityHealthy(alias, codexLbStatus)).length,
    exhaustedAliases: aliases.filter((alias) => (
      providerHealth[alias?.aliasId]?.status === 'cooldown'
      || alias?.health?.exhausted === true
    )).length,
    statuses: aliases
      .map((alias) => ({
        aliasId: alias?.aliasId ?? '',
        email: alias?.email ?? '',
        status: deriveLiveAuthorityState(alias, codexLbStatus).status,
      }))
      .sort((left, right) => left.aliasId.localeCompare(right.aliasId)),
  };
}

function buildLiveLifecycleSummary({ liveAuthorityFacts = {}, archive = {} }) {
  const aliases = Array.isArray(liveAuthorityFacts?.aliases) ? liveAuthorityFacts.aliases : [];
  const codexLbStatus = liveAuthorityFacts?.codexLbStatus ?? { ready: false };
  const itemsByAliasId = new Map();

  for (const alias of aliases) {
    if (!alias?.aliasId) continue;
    itemsByAliasId.set(alias.aliasId, {
      aliasId: alias.aliasId,
      state: deriveLiveAuthorityState(alias, codexLbStatus).lifecycleState,
    });
  }

  for (const archivedAlias of archive?.aliases ?? []) {
    if (!archivedAlias?.aliasId || itemsByAliasId.has(archivedAlias.aliasId)) continue;
    itemsByAliasId.set(archivedAlias.aliasId, {
      aliasId: archivedAlias.aliasId,
      state: archivedAlias?.reinstated ? 'reinstated' : 'archived',
    });
  }

  const items = [...itemsByAliasId.values()].sort((left, right) => left.aliasId.localeCompare(right.aliasId));
  const counts = items.reduce((acc, item) => {
    acc[item.state] = (acc[item.state] ?? 0) + 1;
    return acc;
  }, {});

  return {
    total: items.length,
    counts,
    items,
  };
}

function buildArtifactDisagreements(liveLifecycle, artifactLifecycle) {
  const liveByAliasId = new Map((liveLifecycle?.items ?? []).map((item) => [item.aliasId, item.state]));
  const artifactByAliasId = new Map((artifactLifecycle?.items ?? []).map((item) => [item.aliasId, item.state]));
  const aliasIds = new Set([...liveByAliasId.keys(), ...artifactByAliasId.keys()]);

  return [...aliasIds]
    .map((aliasId) => ({
      aliasId,
      liveState: liveByAliasId.get(aliasId) ?? null,
      artifactState: artifactByAliasId.get(aliasId) ?? null,
    }))
    .filter((entry) => entry.liveState !== entry.artifactState)
    .sort((left, right) => left.aliasId.localeCompare(right.aliasId));
}

function buildManualOnboardingCommands(envVars) {
  const exportLines = envVars
    .filter((entry) => entry.present)
    .map((entry) => `export ${entry.key}="${String(entry.value).replaceAll('"', '\\"')}"`);

  return {
    exportBlock: exportLines.join('\n'),
    status: `node ${CANONICAL_OPERATOR_SCRIPT} --status`,
    run: `node ${CANONICAL_OPERATOR_SCRIPT}`,
    recover: `node ${CANONICAL_OPERATOR_SCRIPT} --repair-codex-lb-only`,
  };
}

function buildReadyCredentials({ auth, workspaces, liveAuthorityFacts }) {
  const usableOwnerAliasIds = new Set(
    (Array.isArray(workspaces) ? workspaces : [])
      .map((workspace) => workspace?.ownerAliasId)
      .filter(Boolean),
  );
  const liveAliasesByAliasId = new Map(
    (liveAuthorityFacts?.aliases ?? [])
      .filter((alias) => alias?.aliasId)
      .map((alias) => [alias.aliasId, alias]),
  );
  const codexLbStatus = liveAuthorityFacts?.codexLbStatus ?? { ready: false };
  const now = Date.now();

  return Object.entries(auth ?? {})
    .map(([aliasId, entry]) => ({ aliasId, entry, liveAlias: liveAliasesByAliasId.get(aliasId) ?? null }))
    .filter(({ entry }) => entry?.access)
    .map(({ aliasId, entry, liveAlias }) => {
      const expired = Number(entry?.expires ?? 0) > 0 && Number(entry?.expires ?? 0) <= now;
      const liveStatus = liveAlias ? deriveLiveAliasStatus(liveAlias, codexLbStatus) : 'loaded';
      const priority = Number(usableOwnerAliasIds.has(aliasId)) * 100
        + Number(String(aliasId).startsWith('workspace-owner-')) * 10
        + Number(liveStatus === 'healthy') * 5
        - Number(expired) * 1000;
      return {
        aliasId,
        email: entry?.email ?? '',
        accountId: entry?.accountId ?? '',
        expires: entry?.expires ?? null,
        expired,
        healthStatus: liveStatus,
        accessToken: entry?.access ?? '',
        refreshToken: entry?.refresh ?? '',
        authExportBlock: [
          `export OPENAI_ACCESS_TOKEN="${String(entry?.access ?? '').replaceAll('"', '\\"')}"`,
          `export OPENAI_ACCOUNT_ID="${String(entry?.accountId ?? '').replaceAll('"', '\\"')}"`,
          `export OPENAI_EMAIL="${String(entry?.email ?? '').replaceAll('"', '\\"')}"`,
        ].join('\n'),
        priority,
      };
    })
    .filter((item) => !item.expired)
    .sort((left, right) => right.priority - left.priority || left.aliasId.localeCompare(right.aliasId));
}

async function discoverLiveWorkspaceRegistry({
  authPath,
  env,
  worktreeRoot,
  workspaceClientFactory = createBrowserlessWorkspaceClient,
}) {
  const workspaceMaxMembers = Number.parseInt(String(env.WORKSPACE_MAX_MEMBERS ?? '8'), 10);
  return discoverOperationalWorkspaceRegistry({
    authPath,
    cachePath: path.join(worktreeRoot, 'state', 'rotation', 'live-workspace-registry.json'),
    persistCache: false,
    includeOwnerAuthFallback: false,
    listWorkspacesForOwner: async ({ ownerAliasId, ownerAuth }) => {
      const client = await workspaceClientFactory({
        accessToken: ownerAuth?.access ?? null,
        accountId: ownerAuth?.accountId ?? null,
      });
      const accounts = await client.getAccounts({ accountIdOverride: ownerAuth?.accountId ?? null });
      const workspaces = [];

      for (const account of (accounts.items ?? []).filter((item) => item.structure === 'workspace')) {
        const observation = {
          workspaceId: account.id,
          workspaceName: account.name ?? null,
          lineage: ownerAuth?.lineage ?? ownerAuth?.workspaceLineage ?? ownerAliasId,
          currentMembers: 0,
          maxMembers: Number.isFinite(workspaceMaxMembers) ? workspaceMaxMembers : null,
          healthyAccounts: 0,
          verificationSource: 'workspace-list-users',
          lastVerifiedAt: new Date().toISOString(),
        };

        try {
          const [me, users] = await Promise.all([
            client.getMe({ accountIdOverride: account.id }).catch(() => null),
            client.listUsers(account.id),
          ]);
          const userItems = users?.items ?? [];
          const self = userItems.find((user) => {
            const userEmail = String(user?.email ?? '').toLowerCase();
            const meEmail = String(me?.email ?? ownerAuth?.email ?? '').toLowerCase();
            return (me?.id && user?.id && user.id === me.id) || (userEmail && meEmail && userEmail === meEmail);
          }) ?? null;

          workspaces.push({
            ...observation,
            currentMembers: typeof users?.total === 'number' ? users.total : userItems.length,
            provenOwnerCapable: String(self?.role ?? '').toLowerCase() === 'account-owner',
            ownerRole: self?.role ?? null,
            eligible: true,
            usable: true,
            deactivated: false,
            eligibilityStatus: 'usable',
          });
        } catch (error) {
          if (isWorkspaceDeactivatedError(error)) {
            workspaces.push({
              ...observation,
              eligible: false,
              usable: false,
              deactivated: true,
              eligibilityStatus: 'workspace-deactivated',
              lastVerificationError: String(error?.message ?? error),
            });
            continue;
          }

          workspaces.push({
            ...observation,
            eligible: false,
            usable: false,
            deactivated: false,
            eligibilityStatus: 'workspace-ineligible',
            lastVerificationError: String(error?.message ?? error),
          });
        }
      }

      return workspaces;
    },
  });
}

async function discoverLiveWorkspaceRegistrySafe(options) {
  try {
    return await discoverLiveWorkspaceRegistry(options);
  } catch (error) {
    return {
      workspaces: [],
      observedWorkspaces: [],
      ownerCandidates: [],
      usableByLineage: {},
      discoveryError: String(error?.message ?? error),
    };
  }
}

export async function buildDashboardSnapshot({
  cwd = process.cwd(),
  homedir = os.homedir(),
  env = process.env,
  liveProbeAlias,
  codexLbStorePath = undefined,
  discoverWorkspaceRegistry,
  workspaceClientFactory = createBrowserlessWorkspaceClient,
} = {}) {
  const worktreeRoot = cwd;
  const envFilePath = await findNearestEnvFile(cwd);
  const repoRoot = envFilePath ? path.dirname(envFilePath) : cwd;
  const agentDir = path.join(homedir, '.pi', 'agent');
  const envFileValues = parseDotEnv(envFilePath ? await loadTextFile(envFilePath) : '');
  const baseMergedEnv = { ...envFileValues, ...env };
  const latestCanonicalArtifactPath = await findLatestCanonicalArtifactPath(worktreeRoot);
  const frictionLedgerPath = path.join(worktreeRoot, 'state', 'rotation', 'friction-ledger.json');
  const authPath = path.join(agentDir, 'auth.json');
  const routerPath = path.join(agentDir, 'account-router.json');
  const healthPath = path.join(agentDir, 'account-router-health.json');
  const poolPath = path.join(agentDir, 'codex-inbox-pool.json');
  const archivePath = path.join(agentDir, 'codex-alias-archive.json');
  const controlPlanePath = baseMergedEnv.AGENTMAIL_CONTROL_PLANE_PATH ?? undefined;
  const effectiveCodexLbStorePath = codexLbStorePath ?? resolveExistingCodexLbStorePath(baseMergedEnv.CODEX_LB_STORE_PATH);

  const [router, health, pool, archive, auth, canonicalArtifact, frictionLedger] = await Promise.all([
    loadJsonFile(routerPath, {}),
    loadJsonFile(healthPath, {}),
    loadJsonFile(poolPath, {}),
    loadJsonFile(archivePath, {}),
    loadJsonFile(authPath, {}),
    latestCanonicalArtifactPath ? loadJsonFile(latestCanonicalArtifactPath, {}) : {},
    loadJsonFile(frictionLedgerPath, {}),
  ]);

  const targetWorkspaceId = normalizeString(env.TARGET_WORKSPACE_ID ?? env.WORKSPACE_ID ?? envFileValues.TARGET_WORKSPACE_ID ?? envFileValues.WORKSPACE_ID);
  const workspaceOwnerEmail = resolveWorkspaceOwnerEmail({
    authData: auth,
    env: baseMergedEnv,
    nowMs: Date.now(),
  });
  const liveRegistry = await (typeof discoverWorkspaceRegistry === 'function'
    ? discoverWorkspaceRegistry({
        authPath,
        auth,
        router,
        pool,
        health,
        worktreeRoot,
        env: baseMergedEnv,
      })
    : discoverLiveWorkspaceRegistrySafe({
        authPath,
        env: baseMergedEnv,
        worktreeRoot,
        workspaceClientFactory,
      }));
  const controlPlane = loadAgentMailControlPlane(controlPlanePath);
  const controlPlaneStatus = buildWorkspaceControlPlaneStatus({
    controlPlane,
    routerData: router,
    poolData: pool,
    registry: liveRegistry,
    targetWorkspaceId,
    workspaceOwnerEmail,
  });
  const liveAuthorityFacts = await collectLiveAuthorityFacts({
    routerPath,
    authPath,
    healthPath,
    poolPath,
    targetWorkspaceId,
    canonicalAgentMailParent: controlPlaneStatus.canonicalParent ?? null,
    codexLbStorePath: effectiveCodexLbStorePath,
    liveProbeAlias: liveProbeAlias ?? createRuntimeVerifiedAliasProbe({
      authJsonPath: authPath,
      healthPath,
      routerPath,
      workspaceClientFactory,
    }),
  });

  const mergedEnv = {
    ...baseMergedEnv,
    WORKSPACE_OWNER_EMAIL: workspaceOwnerEmail ?? baseMergedEnv.WORKSPACE_OWNER_EMAIL ?? '',
    TARGET_WORKSPACE_ID: targetWorkspaceId ?? baseMergedEnv.TARGET_WORKSPACE_ID ?? '',
    CODEX_LB_STORE_PATH: effectiveCodexLbStorePath ?? baseMergedEnv.CODEX_LB_STORE_PATH ?? '',
  };
  const envVars = REQUIRED_ENV_SPECS.map((spec) => {
    const resolved = resolveEnvVarValue({
      spec,
      env,
      envFileValues,
      auth,
      mergedEnv,
      codexLbStorePath: effectiveCodexLbStorePath,
    });
    return {
      ...spec,
      ...resolved,
      present: Boolean(resolved.value),
    };
  });

  const artifactLifecycle = buildArtifactLifecycleSummary({ canonicalArtifact });
  const liveLifecycle = buildLiveLifecycleSummary({ liveAuthorityFacts, archive });
  const routerSummary = summarizeRouterFromLiveFacts(liveAuthorityFacts, health);
  const workspaceSummary = summarizeWorkspaces(liveRegistry);
  const frictionSummary = summarizeFrictionLedger(frictionLedger);
  const readyCredentials = buildReadyCredentials({
    auth,
    workspaces: workspaceSummary.items,
    liveAuthorityFacts,
  });

  const summary = {
    router: routerSummary,
    pool: summarizePool(pool),
    archive: summarizeArchive(archive),
    auth: summarizeAuth(auth),
    workspaces: workspaceSummary,
    lifecycle: liveLifecycle,
    authority: {
      auditedAt: liveAuthorityFacts?.auditedAt ?? null,
      targetWorkspaceId,
      codexLbReady: liveAuthorityFacts?.codexLbStatus?.ready === true,
      canonicalParent: controlPlaneStatus?.canonicalParent ?? null,
      liveOwnerAdmin: controlPlaneStatus?.liveOwnerAdmin ?? null,
      workspaceDiscoveryError: liveRegistry?.discoveryError ?? null,
    },
  };

  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    agentDir,
    latestCanonicalArtifactPath,
    summary,
    artifactEvidence: {
      latestCanonicalArtifactPath,
      lifecycle: artifactLifecycle,
    },
    artifactDisagreements: buildArtifactDisagreements(liveLifecycle, artifactLifecycle),
    frictionLedger: frictionSummary,
    envVars,
    readyCredentials,
    manualOnboarding: {
      commands: buildManualOnboardingCommands(envVars),
    },
    records: {
      routerStatuses: summary.router.statuses,
      authAliases: summary.auth.aliases,
      workspaces: summary.workspaces.items,
      lifecycle: summary.lifecycle.items,
      frictionLedger: frictionSummary.entries,
      readyCredentials,
      authority: summary.authority,
    },
    liveAuthority: liveAuthorityFacts,
  };
}

export { REQUIRED_ENV_SPECS, parseDotEnv };
export { CANONICAL_OPERATOR_SCRIPT };