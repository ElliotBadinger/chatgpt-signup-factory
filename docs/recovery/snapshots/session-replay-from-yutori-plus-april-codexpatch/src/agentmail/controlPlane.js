import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgentMailInbox } from '../pipeline/authTrace/agentMailInboxProvisioning.js';
import { resolveRoutingDomain } from '../pipeline/config/routingDomain.js';
import { signUpAgentAccount, verifyAccount } from './agentWorkspaceSignup.js';

const AGENTMAIL_INBOXES_URL = 'https://api.agentmail.to/v0/inboxes';

export const DEFAULT_CONTROL_PLANE_PATH = path.join(os.homedir(), '.pi', 'agent', 'agentmail-control-plane.json');

function normalizeString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeEmail(value) {
  const text = normalizeString(value);
  return text ? text.toLowerCase() : null;
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function defaultControlPlane() {
  return {
    version: 1,
    workspaces: {},
  };
}

export function loadAgentMailControlPlane(filePath = DEFAULT_CONTROL_PLANE_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.workspaces === 'object') {
      return parsed;
    }
  } catch {}
  return defaultControlPlane();
}

export function saveAgentMailControlPlane(filePath = DEFAULT_CONTROL_PLANE_PATH, controlPlane = defaultControlPlane()) {
  atomicWriteJson(filePath, controlPlane);
  return controlPlane;
}

function isWorkspaceOwnerAlias(value) {
  return /^workspace-owner-[a-z0-9]+$/u.test(String(value ?? '').trim());
}

function workspaceKeyFromAlias(ownerAliasId = null) {
  const alias = normalizeString(ownerAliasId);
  if (!alias) return 'root';
  return alias.replace(/^workspace-owner-/u, '') || alias;
}

function buildWorkspaceHumanIdentity({
  workspace = {},
  env = process.env,
  now = () => Date.now(),
} = {}) {
  const ownerAliasId = normalizeString(workspace.ownerAliasId);
  const workspaceKey = workspaceKeyFromAlias(ownerAliasId);
  const stamp = Number(now());
  const username = `agentmailroot${workspaceKey}${stamp}`;
  return {
    username,
    routingDomain: resolveRoutingDomain({
      ...env,
      WORKSPACE_OWNER_EMAIL: workspace.ownerEmail ?? env.WORKSPACE_OWNER_EMAIL ?? '',
    }),
    humanEmail: `${username}@${resolveRoutingDomain({
      ...env,
      WORKSPACE_OWNER_EMAIL: workspace.ownerEmail ?? env.WORKSPACE_OWNER_EMAIL ?? '',
    })}`,
  };
}

function buildCandidateKey(candidate = {}) {
  return [
    normalizeString(candidate.workspaceId),
    normalizeString(candidate.ownerAliasId),
    normalizeString(candidate.lineage),
    normalizeEmail(candidate.rootEmail ?? candidate.ownerEmail),
  ].join('::');
}

function scoreCandidate(candidate = {}, { workspaceOwnerEmail = null } = {}) {
  let score = 0;
  if (candidate.source === 'control-plane') score += 120;
  if (candidate.source === 'pool') score += 90;
  if (candidate.source === 'router') score += 70;
  if (candidate.source === 'workspace-registry') score += 50;
  if (candidate.source === 'owner-candidate') score += 40;
  if (candidate.verified === true) score += 40;
  if (candidate.hasApiKey === true) score += 25;
  if (isWorkspaceOwnerAlias(candidate.ownerAliasId)) score += 30;
  if (isWorkspaceOwnerAlias(candidate.lineage)) score += 20;
  if (workspaceOwnerEmail && normalizeEmail(candidate.ownerEmail) === normalizeEmail(workspaceOwnerEmail)) score += 40;
  if (workspaceOwnerEmail && normalizeEmail(candidate.rootEmail) === normalizeEmail(workspaceOwnerEmail)) score += 35;
  if (candidate.workspaceId && candidate.rootOrgId && candidate.workspaceId === candidate.rootOrgId) score += 10;
  return score;
}

function pushCandidate(candidateMap, candidate, { workspaceOwnerEmail = null } = {}) {
  if (!candidate?.workspaceId) return;
  const normalized = {
    workspaceId: normalizeString(candidate.workspaceId),
    workspaceName: normalizeString(candidate.workspaceName),
    ownerAliasId: normalizeString(candidate.ownerAliasId),
    ownerEmail: normalizeEmail(candidate.ownerEmail),
    lineage: normalizeString(candidate.lineage),
    rootEmail: normalizeEmail(candidate.rootEmail),
    rootOrgId: normalizeString(candidate.rootOrgId),
    source: normalizeString(candidate.source) ?? 'unknown',
    hasApiKey: candidate.hasApiKey === true,
    verified: candidate.verified === true,
  };
  normalized.score = scoreCandidate(normalized, { workspaceOwnerEmail });
  const key = buildCandidateKey(normalized);
  const current = candidateMap.get(key);
  if (!current || normalized.score > current.score) {
    candidateMap.set(key, normalized);
  }
}

function activeCodexAliasIds(routerData = {}) {
  const pool = (routerData.pools ?? []).find((entry) => entry?.name === 'openai-codex');
  if (Array.isArray(pool?.providers) && pool.providers.length > 0) {
    return new Set(pool.providers.filter(Boolean));
  }
  return new Set(
    (routerData.aliases ?? [])
      .filter((alias) => alias?.cloneFrom === 'openai-codex' && alias?.disabled !== true)
      .map((alias) => alias?.id)
      .filter(Boolean),
  );
}

export function buildCanonicalWorkspaceParentCandidates({
  controlPlane = defaultControlPlane(),
  routerData = {},
  poolData = {},
  registry = {},
  targetWorkspaceId,
  workspaceOwnerEmail = null,
} = {}) {
  const candidateMap = new Map();
  if (!targetWorkspaceId) return [];

  const workspaceRecord = controlPlane.workspaces?.[targetWorkspaceId] ?? null;
  if (workspaceRecord) {
    pushCandidate(candidateMap, {
      workspaceId: workspaceRecord.workspaceId ?? targetWorkspaceId,
      workspaceName: workspaceRecord.workspaceName ?? null,
      ownerAliasId: workspaceRecord.ownerAliasId ?? null,
      ownerEmail: workspaceRecord.ownerEmail ?? null,
      lineage: workspaceRecord.lineage ?? null,
      rootEmail: workspaceRecord.preferredRootEmail ?? null,
      rootOrgId: workspaceRecord.preferredRootOrgId ?? null,
      source: 'control-plane',
      hasApiKey: (workspaceRecord.organizations ?? []).some((record) => typeof record?.apiKey === 'string' && record.apiKey.length > 0),
      verified: (workspaceRecord.organizations ?? []).some((record) => record?.verifyStatus === 'VERIFIED'),
    }, { workspaceOwnerEmail });

    for (const organization of (workspaceRecord.organizations ?? [])) {
      pushCandidate(candidateMap, {
        workspaceId: workspaceRecord.workspaceId ?? targetWorkspaceId,
        workspaceName: workspaceRecord.workspaceName ?? null,
        ownerAliasId: organization.ownerAliasId ?? workspaceRecord.ownerAliasId ?? null,
        ownerEmail: organization.ownerEmail ?? workspaceRecord.ownerEmail ?? null,
        lineage: organization.lineage ?? workspaceRecord.lineage ?? null,
        rootEmail: organization.humanEmail ?? organization.rootEmail ?? workspaceRecord.preferredRootEmail ?? null,
        rootOrgId: organization.organizationId ?? workspaceRecord.preferredRootOrgId ?? null,
        source: 'control-plane',
        hasApiKey: typeof organization.apiKey === 'string' && organization.apiKey.length > 0,
        verified: organization.verifyStatus === 'VERIFIED',
      }, { workspaceOwnerEmail });
    }
  }

  for (const entry of (poolData.entries ?? [])) {
    const workspaceId = normalizeString(entry.workspaceId ?? entry.rootOrgId);
    if (workspaceId !== targetWorkspaceId) continue;
    pushCandidate(candidateMap, {
      workspaceId,
      workspaceName: entry.workspaceName ?? null,
      ownerAliasId: entry.ownerAliasId ?? null,
      ownerEmail: entry.ownerEmail ?? entry.rootEmail ?? null,
      lineage: entry.lineage ?? entry.workspaceGroupKey ?? null,
      rootEmail: entry.rootEmail ?? null,
      rootOrgId: entry.rootOrgId ?? null,
      source: 'pool',
      hasApiKey: typeof entry.rootApiKey === 'string' && entry.rootApiKey.length > 0,
    }, { workspaceOwnerEmail });
  }

  const activeIds = activeCodexAliasIds(routerData);
  for (const alias of (routerData.aliases ?? [])) {
    if (!activeIds.has(alias?.id)) continue;
    const placementContext = alias?.placementContext ?? {};
    const workspaceId = normalizeString(placementContext.workspaceId ?? alias.workspaceId);
    if (workspaceId !== targetWorkspaceId) continue;
    pushCandidate(candidateMap, {
      workspaceId,
      workspaceName: placementContext.workspaceName ?? alias.workspaceName ?? null,
      ownerAliasId: placementContext.ownerAliasId ?? alias.ownerAliasId ?? null,
      ownerEmail: placementContext.ownerEmail ?? alias.ownerEmail ?? null,
      lineage: placementContext.lineage ?? alias.lineage ?? alias.workspaceLineage ?? null,
      rootEmail: placementContext.rootEmail ?? alias.rootEmail ?? null,
      rootOrgId: placementContext.rootOrgId ?? alias.rootOrgId ?? null,
      source: 'router',
    }, { workspaceOwnerEmail });
  }

  for (const workspace of (registry.workspaces ?? [])) {
    const workspaceId = normalizeString(workspace.workspaceId);
    if (workspaceId !== targetWorkspaceId) continue;
    pushCandidate(candidateMap, {
      workspaceId,
      workspaceName: workspace.workspaceName ?? null,
      ownerAliasId: workspace.ownerAliasId ?? null,
      ownerEmail: workspace.ownerEmail ?? null,
      lineage: workspace.lineage ?? null,
      rootEmail: workspace.ownerEmail ?? null,
      rootOrgId: workspace.workspaceId ?? null,
      source: 'workspace-registry',
    }, { workspaceOwnerEmail });
  }

  for (const owner of (registry.ownerCandidates ?? [])) {
    const ownerAccountId = normalizeString(owner.ownerAccountId);
    if (ownerAccountId !== targetWorkspaceId) continue;
    pushCandidate(candidateMap, {
      workspaceId: targetWorkspaceId,
      workspaceName: null,
      ownerAliasId: owner.ownerAliasId ?? null,
      ownerEmail: owner.ownerEmail ?? null,
      lineage: owner.lineage ?? owner.ownerAliasId ?? null,
      rootEmail: owner.ownerEmail ?? null,
      rootOrgId: owner.ownerAccountId ?? null,
      source: 'owner-candidate',
    }, { workspaceOwnerEmail });
  }

  return [...candidateMap.values()].sort((left, right) => right.score - left.score || String(left.ownerAliasId ?? '').localeCompare(String(right.ownerAliasId ?? '')));
}

export function resolveCanonicalWorkspaceParent(options = {}) {
  const candidates = buildCanonicalWorkspaceParentCandidates(options);
  return candidates[0] ?? null;
}

export function evaluateWorkspaceParentAgreement({
  alias = {},
  canonicalParent = null,
  poolEntry = null,
  targetWorkspaceId = null,
} = {}) {
  const observedWorkspaceId = normalizeString(alias?.placementContext?.workspaceId ?? alias?.workspaceId ?? poolEntry?.workspaceId ?? poolEntry?.rootOrgId ?? null);
  if (!canonicalParent || !targetWorkspaceId || observedWorkspaceId !== targetWorkspaceId) {
    return { ok: true, reason: null };
  }

  const observedOwnerAliasId = normalizeString(alias?.placementContext?.ownerAliasId ?? alias?.ownerAliasId ?? poolEntry?.ownerAliasId ?? null);
  const observedLineage = normalizeString(alias?.placementContext?.lineage ?? alias?.lineage ?? alias?.workspaceLineage ?? poolEntry?.lineage ?? poolEntry?.workspaceGroupKey ?? null);
  const observedRootEmail = normalizeEmail(alias?.placementContext?.rootEmail ?? alias?.rootEmail ?? poolEntry?.rootEmail ?? null);

  if (canonicalParent.ownerAliasId && observedOwnerAliasId && canonicalParent.ownerAliasId !== observedOwnerAliasId) {
    return {
      ok: false,
      reason: 'agentmail-parent-lineage-mismatch',
      canonicalOwnerAliasId: canonicalParent.ownerAliasId,
      observedOwnerAliasId,
      canonicalLineage: canonicalParent.lineage ?? null,
      observedLineage,
      canonicalRootEmail: canonicalParent.rootEmail ?? null,
      observedRootEmail,
    };
  }

  if (canonicalParent.lineage && observedLineage && canonicalParent.lineage !== observedLineage) {
    return {
      ok: false,
      reason: 'agentmail-parent-lineage-mismatch',
      canonicalOwnerAliasId: canonicalParent.ownerAliasId ?? null,
      observedOwnerAliasId,
      canonicalLineage: canonicalParent.lineage,
      observedLineage,
      canonicalRootEmail: canonicalParent.rootEmail ?? null,
      observedRootEmail,
    };
  }

  if (!observedOwnerAliasId && !observedLineage) {
    return {
      ok: false,
      reason: 'agentmail-parent-lineage-unproven',
      canonicalOwnerAliasId: canonicalParent.ownerAliasId ?? null,
      canonicalLineage: canonicalParent.lineage ?? null,
      canonicalRootEmail: canonicalParent.rootEmail ?? null,
    };
  }

  return {
    ok: true,
    reason: null,
    canonicalOwnerAliasId: canonicalParent.ownerAliasId ?? null,
    observedOwnerAliasId,
    canonicalLineage: canonicalParent.lineage ?? null,
    observedLineage,
    canonicalRootEmail: canonicalParent.rootEmail ?? null,
    observedRootEmail,
  };
}

function ensureWorkspaceRecord(controlPlane = defaultControlPlane(), workspace = {}) {
  const workspaceId = normalizeString(workspace.workspaceId);
  if (!workspaceId) {
    throw new Error('workspaceId is required');
  }

  const current = controlPlane.workspaces?.[workspaceId] ?? {
    workspaceId,
    workspaceName: null,
    ownerAliasId: null,
    ownerEmail: null,
    lineage: null,
    preferredRootEmail: null,
    preferredRootOrgId: null,
    organizations: [],
  };
  const next = {
    ...current,
    workspaceId,
    workspaceName: normalizeString(workspace.workspaceName) ?? current.workspaceName ?? null,
    ownerAliasId: normalizeString(workspace.ownerAliasId) ?? current.ownerAliasId ?? null,
    ownerEmail: normalizeEmail(workspace.ownerEmail) ?? current.ownerEmail ?? null,
    lineage: normalizeString(workspace.lineage) ?? current.lineage ?? null,
    preferredRootEmail: normalizeEmail(workspace.rootEmail) ?? current.preferredRootEmail ?? null,
    preferredRootOrgId: normalizeString(workspace.rootOrgId) ?? current.preferredRootOrgId ?? null,
    organizations: Array.isArray(current.organizations) ? current.organizations : [],
  };
  controlPlane.workspaces[workspaceId] = next;
  return next;
}

export function recordWorkspaceParentSignUp({
  controlPlane = defaultControlPlane(),
  workspace = {},
  record = {},
  now = () => new Date().toISOString(),
} = {}) {
  const workspaceRecord = ensureWorkspaceRecord(controlPlane, workspace);
  const organizationId = normalizeString(record.organizationId);
  const updatedAt = now();
  const nextRecord = {
    organizationId,
    inboxId: normalizeString(record.inboxId),
    apiKey: normalizeString(record.apiKey),
    humanEmail: normalizeEmail(record.humanEmail),
    username: normalizeString(record.username),
    routingDomain: normalizeString(record.routingDomain),
    verifyStatus: normalizeString(record.verifyStatus) ?? 'PENDING_OTP',
    createdAt: normalizeString(record.createdAt) ?? updatedAt,
    updatedAt,
    ownerAliasId: normalizeString(record.ownerAliasId) ?? workspaceRecord.ownerAliasId ?? null,
    ownerEmail: normalizeEmail(record.ownerEmail) ?? workspaceRecord.ownerEmail ?? null,
    lineage: normalizeString(record.lineage) ?? workspaceRecord.lineage ?? null,
    rootEmail: normalizeEmail(record.rootEmail) ?? workspaceRecord.preferredRootEmail ?? null,
  };

  const organizations = [...workspaceRecord.organizations];
  const existingIndex = organizations.findIndex((item) => item.organizationId === organizationId || (item.humanEmail && item.humanEmail === nextRecord.humanEmail));
  if (existingIndex >= 0) {
    organizations[existingIndex] = {
      ...organizations[existingIndex],
      ...nextRecord,
    };
  } else {
    organizations.push(nextRecord);
  }

  controlPlane.workspaces[workspaceRecord.workspaceId] = {
    ...workspaceRecord,
    organizations,
    preferredRootEmail: nextRecord.humanEmail ?? workspaceRecord.preferredRootEmail ?? null,
    preferredRootOrgId: nextRecord.organizationId ?? workspaceRecord.preferredRootOrgId ?? null,
  };
  return controlPlane.workspaces[workspaceRecord.workspaceId];
}

export async function signUpWorkspaceParentOrganization({
  workspace = {},
  controlPlanePath = DEFAULT_CONTROL_PLANE_PATH,
  controlPlane = loadAgentMailControlPlane(controlPlanePath),
  fetchImpl = fetch,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  const identity = buildWorkspaceHumanIdentity({ workspace, env, now });
  const payload = await signUpAgentAccount({
    humanEmail: identity.humanEmail,
    username: identity.username,
    fetchImpl,
  });

  const updatedControlPlane = { ...controlPlane, workspaces: { ...(controlPlane.workspaces ?? {}) } };
  const workspaceRecord = recordWorkspaceParentSignUp({
    controlPlane: updatedControlPlane,
    workspace,
    record: {
      organizationId: payload.organization_id ?? null,
      inboxId: payload.inbox_id ?? null,
      apiKey: payload.api_key ?? null,
      humanEmail: identity.humanEmail,
      username: identity.username,
      routingDomain: identity.routingDomain,
      verifyStatus: 'PENDING_OTP',
      ownerAliasId: workspace.ownerAliasId ?? null,
      ownerEmail: workspace.ownerEmail ?? null,
      lineage: workspace.lineage ?? workspace.ownerAliasId ?? null,
      rootEmail: identity.humanEmail,
      createdAt: new Date(Number(now())).toISOString(),
    },
    now: () => new Date(Number(now())).toISOString(),
  });
  saveAgentMailControlPlane(controlPlanePath, updatedControlPlane);

  return {
    workspace: workspaceRecord,
    record: workspaceRecord.organizations.find((item) => item.organizationId === (payload.organization_id ?? null) || item.humanEmail === identity.humanEmail) ?? null,
    verifyCommand: `node src/cli/pipeline-agentmail-control.js verify --workspace-id ${workspace.workspaceId} --api-key ${payload.api_key ?? '<api-key>'} --otp-code <6-digit-otp>`,
  };
}

export async function verifyWorkspaceParentOrganization({
  workspaceId,
  apiKey,
  otpCode,
  controlPlanePath = DEFAULT_CONTROL_PLANE_PATH,
  controlPlane = loadAgentMailControlPlane(controlPlanePath),
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
} = {}) {
  const verification = await verifyAccount(apiKey, otpCode, { fetchImpl });
  const workspaceRecord = controlPlane.workspaces?.[workspaceId];
  if (!workspaceRecord) {
    throw new Error(`No control-plane workspace record found for ${workspaceId}`);
  }

  const nextControlPlane = { ...controlPlane, workspaces: { ...(controlPlane.workspaces ?? {}) } };
  const nextWorkspaceRecord = {
    ...workspaceRecord,
    organizations: (workspaceRecord.organizations ?? []).map((record) => {
      if (record.apiKey !== apiKey) return record;
      return {
        ...record,
        verifyStatus: 'VERIFIED',
        updatedAt: now(),
      };
    }),
  };
  nextControlPlane.workspaces[workspaceId] = nextWorkspaceRecord;
  saveAgentMailControlPlane(controlPlanePath, nextControlPlane);

  return {
    verification,
    workspace: nextWorkspaceRecord,
  };
}

function selectWorkspaceOrganization(workspaceRecord = null, { requireVerified = true } = {}) {
  if (!workspaceRecord) return null;
  const organizations = [...(workspaceRecord.organizations ?? [])];
  const sorted = organizations.sort((left, right) => {
    const verifiedDelta = Number(right.verifyStatus === 'VERIFIED') - Number(left.verifyStatus === 'VERIFIED');
    if (verifiedDelta !== 0) return verifiedDelta;
    return String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''));
  });
  const selected = sorted.find((record) => !requireVerified || record.verifyStatus === 'VERIFIED') ?? null;
  return selected;
}

export async function listWorkspaceInboxes({
  workspaceId,
  controlPlanePath = DEFAULT_CONTROL_PLANE_PATH,
  controlPlane = loadAgentMailControlPlane(controlPlanePath),
  fetchImpl = fetch,
} = {}) {
  const workspaceRecord = controlPlane.workspaces?.[workspaceId] ?? null;
  const organization = selectWorkspaceOrganization(workspaceRecord);
  if (!organization?.apiKey) {
    throw new Error(`No verified AgentMail organization with API key found for workspace ${workspaceId}`);
  }

  const response = await fetchImpl(AGENTMAIL_INBOXES_URL, {
    headers: {
      Authorization: `Bearer ${organization.apiKey}`,
    },
  });
  if (!response.ok) {
    const text = typeof response.text === 'function' ? await response.text() : '';
    throw new Error(`GET /v0/inboxes failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return {
    workspace: workspaceRecord,
    organization,
    inboxes: await response.json(),
  };
}

export async function createWorkspaceInbox({
  workspaceId,
  displayName = 'Codex Control Plane Inbox',
  controlPlanePath = DEFAULT_CONTROL_PLANE_PATH,
  controlPlane = loadAgentMailControlPlane(controlPlanePath),
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const workspaceRecord = controlPlane.workspaces?.[workspaceId] ?? null;
  const organization = selectWorkspaceOrganization(workspaceRecord);
  if (!organization?.apiKey) {
    throw new Error(`No verified AgentMail organization with API key found for workspace ${workspaceId}`);
  }

  const inbox = await createAgentMailInbox({
    apiKey: organization.apiKey,
    displayName,
    fetchImpl,
    now,
  });
  return {
    workspace: workspaceRecord,
    organization,
    inbox,
  };
}