import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runBootstrap as defaultRunBootstrap } from '../pipeline/bootstrap/runBootstrap.js';
import { createRealStage1LiveHooks } from '../pipeline/bootstrap/realStage1.js';
import { analyzeOpenAiAuthTelemetry } from '../pipeline/authTrace/openaiAuthTelemetryAnalysis.js';
import { replayOpenAiAuthFlow } from '../pipeline/authTrace/openaiAuthReplay.js';
import { recoverBrowserlessIdentity } from '../pipeline/authTrace/recoverBrowserlessIdentity.js';
import { resolveExhaustedAliasLineage } from '../pipeline/rotation/resolveExhaustedAliasLineage.js';
import { bootstrapRuntimeCapacity } from '../pipeline/rotation/bootstrapRuntimeCapacity.js';
import { readArchive } from '../pipeline/rotation/archiveManager.js';

const AGENTMAIL_INBOXES_URL = 'https://api.agentmail.to/v0/inboxes';
const DEFAULT_AUTH_TRACE_DIR = path.join('artifacts', 'auth-traces', '2026-03-15T20-01-44-099Z-deep-golden-signup-v2');

function countUsableEntries(pool = {}) {
  return (pool.entries ?? []).filter((entry) => entry.status === 'available' || entry.status === 'prewarmed').length;
}

export function collectFailedWorkspaceCleanupCandidates({
  poolEntries = [],
  routerAliases = [],
  allowedLineages = [],
} = {}) {
  const activeRouterEmails = new Set((routerAliases ?? []).map((alias) => String(alias?.email ?? '').toLowerCase()).filter(Boolean));
  const allowedLineageSet = new Set((allowedLineages ?? []).filter(Boolean));

  return (poolEntries ?? [])
    .filter((entry) => entry?.inboxAddress)
    .filter((entry) => entry.status === 'failed' || entry.status === 'chatgpt-used')
    .filter((entry) => !activeRouterEmails.has(String(entry.inboxAddress).toLowerCase()))
    .filter((entry) => allowedLineageSet.size === 0 || allowedLineageSet.has(entry.lineage ?? entry.workspaceGroupKey ?? null))
    .map((entry) => ({
      aliasId: entry.linkedAliasId ?? null,
      email: entry.inboxAddress,
      lineage: entry.lineage ?? entry.workspaceGroupKey ?? null,
      workspaceId: entry.workspaceId ?? entry.rootOrgId ?? null,
      placementContext: {
        aliasId: entry.linkedAliasId ?? null,
        aliasEmail: entry.inboxAddress,
        lineage: entry.lineage ?? entry.workspaceGroupKey ?? null,
        workspaceId: entry.workspaceId ?? entry.rootOrgId ?? null,
        workspaceName: entry.workspaceName ?? null,
        rootEmail: entry.rootEmail ?? null,
        rootOrgId: entry.rootOrgId ?? null,
        ownerAliasId: entry.ownerAliasId ?? null,
      },
    }));
}

function activeCodexAliasIds(routerData = {}) {
  const openAiCodexAliases = new Set(
    (routerData.aliases ?? [])
      .filter((alias) => alias?.cloneFrom === 'openai-codex' && alias?.disabled !== true)
      .map((alias) => alias.id),
  );
  const openAiCodexPool = (routerData.pools ?? []).find((pool) => pool?.name === 'openai-codex');
  const providerIds = new Set((openAiCodexPool?.providers ?? []).filter(Boolean));
  if (providerIds.size === 0) {
    return openAiCodexAliases;
  }
  return new Set([...openAiCodexAliases].filter((aliasId) => providerIds.has(aliasId)));
}

export function collectRuntimeExhaustedAliases({
  routerData = {},
  healthData = {},
  workspaceOwnerEmail = null,
  forceReplaceAll9 = false,
} = {}) {
  const providers = healthData?.providers ?? {};
  const codexAliasIds = activeCodexAliasIds(routerData);
  const exhaustedAliases = [];
  for (const alias of (routerData.aliases ?? [])) {
    const email = alias.email;
    if (!email || (workspaceOwnerEmail && email === workspaceOwnerEmail)) continue;
    if (!codexAliasIds.has(alias.id)) continue;
    const status = providers[alias.id]?.status;
    const isExhausted = status === 'cooldown' || forceReplaceAll9;
    if (!isExhausted) continue;
    exhaustedAliases.push({
      aliasId: alias.id,
      email,
      lineage: alias.lineage ?? alias.workspaceLineage ?? null,
    });
  }
  return exhaustedAliases;
}

export async function listAgentMailInboxes(apiKey, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(AGENTMAIL_INBOXES_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GET /v0/inboxes failed: ${response.status} ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data : (data.inboxes ?? data.items ?? data.data ?? []);
}

function inboxAddressFromItem(item = {}) {
  return item.email_address ?? item.inbox_address ?? item.address ?? item.inbox_id ?? null;
}

function inboxIdFromItem(item = {}) {
  return item.inbox_id ?? item.id ?? null;
}

function controllerIdFromEmail(email = '') {
  return `controller-${String(email).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;
}

function rootApiKeyPrefix(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey) return null;
  const underscoreIndex = apiKey.indexOf('_', apiKey.indexOf('_') + 1);
  return underscoreIndex > 0 ? apiKey.slice(0, underscoreIndex) : apiKey.slice(0, Math.min(5, apiKey.length));
}

function knownInboxIdentifiers(knownPoolEntries = [], { ownerEmail = null } = {}) {
  return (knownPoolEntries ?? [])
    .filter((entry) => !ownerEmail || entry.rootEmail === ownerEmail)
    .filter((entry) => entry?.status !== 'failed')
    .flatMap((entry) => [entry.agentMailInboxId, entry.inboxAddress])
    .filter(Boolean);
}

function buildKnownInboxIdSet(knownPoolEntries = [], { ownerEmail = null } = {}) {
  return new Set(knownInboxIdentifiers(knownPoolEntries, { ownerEmail }));
}

function mapInboxesToPoolEntries({
  inboxes = [],
  inboxIds = null,
  knownPoolEntries = [],
  ownerEmail = null,
  workspaceId = null,
  workspaceName = null,
  lineage = null,
  ownerAliasId = null,
  fullApiKey = null,
  now = () => Date.now(),
} = {}) {
  const knownIds = buildKnownInboxIdSet(knownPoolEntries, { ownerEmail });
  const targetInboxIds = inboxIds ? new Set([...inboxIds].filter(Boolean)) : null;

  return inboxes
    .map((item) => ({ inboxAddress: inboxAddressFromItem(item), agentMailInboxId: inboxIdFromItem(item) }))
    .filter((item) => item.inboxAddress && item.agentMailInboxId)
    .filter((item) => !targetInboxIds || targetInboxIds.has(item.agentMailInboxId))
    .filter((item) => !knownIds.has(item.agentMailInboxId) && !knownIds.has(item.inboxAddress))
    .map((item) => ({
      inboxAddress: item.inboxAddress,
      agentMailInboxId: item.agentMailInboxId,
      rootEmail: ownerEmail,
      rootOrgId: workspaceId ?? null,
      rootApiKey: fullApiKey,
      rootApiKeyPrefix: rootApiKeyPrefix(fullApiKey),
      cfRuleId: null,
      cfKvNamespaceId: null,
      workspaceGroupKey: lineage ?? workspaceId ?? ownerAliasId ?? ownerEmail,
      workspaceId: workspaceId ?? null,
      workspaceName,
      lineage: lineage ?? null,
      ownerAliasId: ownerAliasId ?? null,
      status: 'available',
      statusUpdatedAt: now(),
    }));
}

function getAuthorizeRedirect(replay = null) {
  return replay?.steps?.find((step) => step.name === 'authorize_with_login_hint')?.responseHeaders?.location ?? null;
}

function defaultFreshRootEmail({ prefix = 'agentmailroot', now = () => Date.now() } = {}) {
  return `${prefix}${now()}@epistemophile.space`;
}

export function createArchiveReinstatableEntriesProvider({ archivePath } = {}) {
  return async function archiveReinstatableEntriesProvider({ lineage, workspaceId, workspaceName = null, ownerAliasId = null } = {}) {
    const archive = readArchive({ archivePath });
    const entries = [];
    for (const alias of archive.aliases ?? []) {
      if (alias?.reinstated === true) continue;
      const reusableEntries = alias?.reinstatablePoolEntries ?? alias?.usablePoolEntries ?? (alias?.poolEntry ? [alias.poolEntry] : []);
      for (const reusableEntry of reusableEntries) {
        if (!reusableEntry?.inboxAddress || !reusableEntry?.agentMailInboxId) continue;
        const entryLineage = reusableEntry.lineage ?? alias.lineage ?? null;
        const entryWorkspaceId = reusableEntry.workspaceId ?? alias.workspaceId ?? null;
        if (lineage && entryLineage && entryLineage !== lineage) continue;
        if (workspaceId && entryWorkspaceId && entryWorkspaceId !== workspaceId) continue;
        entries.push({
          ...reusableEntry,
          workspaceName: reusableEntry.workspaceName ?? alias.workspaceName ?? workspaceName,
          lineage: entryLineage ?? lineage ?? null,
          workspaceId: entryWorkspaceId ?? workspaceId ?? null,
          ownerAliasId: reusableEntry.ownerAliasId ?? alias.ownerAliasId ?? ownerAliasId,
          status: reusableEntry.status ?? 'available',
        });
      }
    }
    return entries;
  };
}

function buildUsableSupplyRootRecord({
  rootEmail,
  lineage,
  workspaceId,
  workspaceName = null,
  ownerAliasId = null,
  source = 'live-bootstrap-new-root',
  now = () => Date.now(),
} = {}) {
  return {
    rootEmail,
    ownerEmail: rootEmail,
    ownerAliasId,
    lineage: lineage ?? null,
    workspaceId: workspaceId ?? null,
    workspaceName,
    usable: true,
    source,
    lastVerifiedAt: new Date(now()).toISOString(),
  };
}

async function filterUsablePoolEntries(entries = [], { verifyEntry } = {}) {
  if (entries.length === 0) {
    return { createdEntries: [], excludedEntries: [] };
  }
  if (typeof verifyEntry !== 'function') {
    return { createdEntries: entries, excludedEntries: [] };
  }

  const createdEntries = [];
  const excludedEntries = [];
  for (const entry of entries) {
    const verification = await verifyEntry({ entry, email: entry.inboxAddress, agentMailApiKey: entry.rootApiKey });
    if (verification?.ok === true) {
      createdEntries.push(entry);
      continue;
    }
    excludedEntries.push({
      ...entry,
      reason: verification?.reason ?? 'entry-not-yet-usable',
      authBranch: verification?.authBranch ?? null,
      verdict: verification?.verdict ?? null,
      authorizeRedirect: verification?.authorizeRedirect ?? null,
    });
  }
  return { createdEntries, excludedEntries };
}

export async function verifyRecoveredInboxUsability({
  email,
  agentMailApiKey,
  authTraceDir = DEFAULT_AUTH_TRACE_DIR,
  analyzeAuthTrace = analyzeOpenAiAuthTelemetry,
  replayAuth = replayOpenAiAuthFlow,
} = {}) {
  if (!email || !agentMailApiKey) {
    return { ok: false, reason: 'recovered-inbox-verification-missing-input' };
  }

  const analysis = await analyzeAuthTrace(authTraceDir, { dryRun: true });
  const recovery = await recoverBrowserlessIdentity({
    email,
    analysis,
    agentMailApiKey,
    replayAuth,
    analyzeAuthTrace: async () => analysis,
  });

  if (recovery?.status === 'recovered' && recovery?.replay?.verdict === 'authenticated') {
    return {
      ok: true,
      reason: null,
      authBranch: recovery.branch ?? recovery?.replay?.branch ?? null,
      verdict: recovery?.replay?.verdict ?? null,
    };
  }

  const replay = recovery?.replay ?? null;
  const authorizeRedirect = getAuthorizeRedirect(replay);
  const latestAttempt = recovery?.attempts?.at?.(-1) ?? null;
  const passwordOnlyAttempt = (recovery?.attempts ?? []).find((attempt) => (
    attempt?.branch === 'password-login' && attempt?.reason === 'password-login-unsupported'
  )) ?? null;
  const isPasswordOnly = Boolean(passwordOnlyAttempt) || (
    (replay?.branch === 'password-login' && replay?.blockerReason === 'password-login-unsupported')
    || (replay?.verdict === 'unsupported-authorize-redirect' && String(authorizeRedirect).includes('/log-in/password'))
  );

  return {
    ok: false,
    reason: isPasswordOnly ? 'password-login-unsupported' : (recovery?.reason ?? latestAttempt?.reason ?? replay?.blockerReason ?? replay?.verdict ?? 'recovered-inbox-auth-unusable'),
    authBranch: passwordOnlyAttempt?.branch ?? recovery?.branch ?? replay?.branch ?? latestAttempt?.branch ?? null,
    verdict: replay?.verdict ?? null,
    authorizeRedirect,
  };
}

async function filterRecoveredEntries(entries = [], { verifyRecoveredEntry } = {}) {
  if (entries.length === 0) {
    return { createdEntries: [], excludedEntries: [] };
  }
  if (typeof verifyRecoveredEntry !== 'function') {
    return { createdEntries: entries, excludedEntries: [] };
  }

  const createdEntries = [];
  const excludedEntries = [];
  for (const entry of entries) {
    const verification = await verifyRecoveredEntry({
      email: entry.inboxAddress,
      agentMailApiKey: entry.rootApiKey,
      entry,
    });
    if (verification?.ok === true) {
      createdEntries.push(entry);
      continue;
    }
    excludedEntries.push({
      ...entry,
      reason: verification?.reason ?? 'recovered-inbox-auth-unusable',
      authBranch: verification?.authBranch ?? null,
      verdict: verification?.verdict ?? null,
      authorizeRedirect: verification?.authorizeRedirect ?? null,
    });
  }
  return { createdEntries, excludedEntries };
}

export function createLiveBootstrapLineageRunner({
  cwd = process.cwd(),
  createRealHooks = createRealStage1LiveHooks,
  runBootstrap = defaultRunBootstrap,
  listInboxes = listAgentMailInboxes,
  verifyRecoveredEntry = verifyRecoveredInboxUsability,
  verifyProvisionedEntry = null,
  reinstatableEntriesProvider = async () => [],
  createCandidateRootEmail = ({ now: nowFn }) => defaultFreshRootEmail({ now: nowFn }),
  allowFreshRootEscalation = true,
  now = () => Date.now(),
} = {}) {
  async function attemptBootstrapForRoot({
    rootEmail,
    lineage,
    ownerAliasId,
    workspaceId,
    workspaceName,
    knownPoolEntries,
    reasonContext,
  }) {
    const runId = `${now()}-${lineage ?? ownerAliasId ?? 'unknown'}-${reasonContext}`;
    const stateDir = path.join(cwd, 'state', 'bootstrap-live-fix', runId);
    const artifactDir = path.join(cwd, 'artifacts', 'bootstrap-live-fix', runId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(artifactDir, { recursive: true });

    const hooks = createRealHooks({
      artifactDir,
      cwd,
      inboxCount: 3,
      inboxDisplayNamePrefix: `Live Fix ${lineage ?? ownerAliasId ?? 'root'}`,
    });

    try {
      const bootstrapResult = await runBootstrap({
        stateDir,
        artifactDir,
        candidateRootEmails: [rootEmail],
        dryRun: false,
        verifyMailboxAuthority: hooks.verifyMailboxAuthority,
        createOrRecoverAgentMailController: hooks.createOrRecoverAgentMailController,
        captureApiKey: hooks.captureApiKey,
        createInboxes: hooks.createInboxes,
      });

      const controllerId = controllerIdFromEmail(rootEmail);
      const fullApiKey = hooks.getApiKeyForController(controllerId);
      if (!fullApiKey) {
        return { ok: false, reason: 'bootstrap-root-api-key-missing', createdEntries: [], excludedEntries: [], artifactDir, stateDir };
      }

      const createdInboxIds = new Set(
        (bootstrapResult.controllers ?? [])
          .flatMap((controller) => controller?.outputs?.inboxCreation?.inboxIds ?? [])
          .filter(Boolean),
      );

      const inboxes = await listInboxes(fullApiKey);
      const createdEntries = createdInboxIds.size > 0
        ? mapInboxesToPoolEntries({
            inboxes,
            inboxIds: createdInboxIds,
            knownPoolEntries,
            ownerEmail: rootEmail,
            workspaceId,
            workspaceName,
            lineage,
            ownerAliasId,
            fullApiKey,
            now,
          })
        : [];
      const usableCreated = await filterUsablePoolEntries(createdEntries, { verifyEntry: verifyProvisionedEntry });
      if (usableCreated.createdEntries.length > 0) {
        return {
          ok: true,
          reason: null,
          createdEntries: usableCreated.createdEntries,
          excludedEntries: usableCreated.excludedEntries,
          liveInboxCount: usableCreated.createdEntries.length,
          knownLiveInboxCount: 0,
          artifactDir,
          stateDir,
          rootEmail,
        };
      }
      if (createdEntries.length > 0 && usableCreated.excludedEntries.length > 0) {
        return {
          ok: false,
          reason: 'bootstrap-created-inboxes-not-yet-usable',
          createdEntries: [],
          excludedEntries: usableCreated.excludedEntries,
          liveInboxCount: createdEntries.length,
          knownLiveInboxCount: 0,
          artifactDir,
          stateDir,
          rootEmail,
        };
      }

      const recoveredEntries = mapInboxesToPoolEntries({
        inboxes,
        knownPoolEntries,
        ownerEmail: rootEmail,
        workspaceId,
        workspaceName,
        lineage,
        ownerAliasId,
        fullApiKey,
        now,
      });
      const knownIds = new Set(knownInboxIdentifiers(knownPoolEntries, { ownerEmail: rootEmail }));
      const knownLiveInboxCount = inboxes
        .map((item) => ({ inboxAddress: inboxAddressFromItem(item), agentMailInboxId: inboxIdFromItem(item) }))
        .filter((item) => item.inboxAddress && item.agentMailInboxId)
        .filter((item) => knownIds.has(item.agentMailInboxId) || knownIds.has(item.inboxAddress))
        .length;
      const filteredRecovered = await filterRecoveredEntries(recoveredEntries, { verifyRecoveredEntry });

      return {
        ok: filteredRecovered.createdEntries.length > 0,
        reason: filteredRecovered.createdEntries.length > 0
          ? 'bootstrap-recovered-existing-live-inboxes'
          : (filteredRecovered.excludedEntries.length > 0
              ? 'bootstrap-recovered-inboxes-unusable'
              : (knownLiveInboxCount > 0
                  ? 'bootstrap-live-inboxes-already-known'
                  : 'bootstrap-created-no-usable-pool-entries')),
        createdEntries: filteredRecovered.createdEntries,
        excludedEntries: filteredRecovered.excludedEntries,
        liveInboxCount: inboxes.length,
        knownLiveInboxCount,
        artifactDir,
        stateDir,
        rootEmail,
      };
    } catch (error) {
      const controllerId = controllerIdFromEmail(rootEmail);
      const fullApiKey = hooks.getApiKeyForController(controllerId);
      if (fullApiKey) {
        try {
          const inboxes = await listInboxes(fullApiKey);
          const recoveredEntries = mapInboxesToPoolEntries({
            inboxes,
            knownPoolEntries,
            ownerEmail: rootEmail,
            workspaceId,
            workspaceName,
            lineage,
            ownerAliasId,
            fullApiKey,
            now,
          });
          const knownIds = new Set(knownInboxIdentifiers(knownPoolEntries, { ownerEmail: rootEmail }));
          const knownLiveInboxCount = inboxes
            .map((item) => ({ inboxAddress: inboxAddressFromItem(item), agentMailInboxId: inboxIdFromItem(item) }))
            .filter((item) => item.inboxAddress && item.agentMailInboxId)
            .filter((item) => knownIds.has(item.agentMailInboxId) || knownIds.has(item.inboxAddress))
            .length;
          const filteredRecovered = await filterRecoveredEntries(recoveredEntries, { verifyRecoveredEntry });
          if (filteredRecovered.createdEntries.length > 0) {
            return {
              ok: true,
              reason: 'bootstrap-recovered-existing-live-inboxes',
              createdEntries: filteredRecovered.createdEntries,
              excludedEntries: filteredRecovered.excludedEntries,
              liveInboxCount: inboxes.length,
              knownLiveInboxCount,
              artifactDir,
              stateDir,
              rootEmail,
              recoverySourceError: String(error?.message ?? error),
            };
          }
          if (filteredRecovered.excludedEntries.length > 0) {
            return {
              ok: false,
              reason: 'bootstrap-recovered-inboxes-unusable',
              createdEntries: [],
              excludedEntries: filteredRecovered.excludedEntries,
              liveInboxCount: inboxes.length,
              knownLiveInboxCount,
              artifactDir,
              stateDir,
              rootEmail,
              recoverySourceError: String(error?.message ?? error),
            };
          }
          if (knownLiveInboxCount > 0) {
            return {
              ok: false,
              reason: 'bootstrap-live-inboxes-already-known',
              createdEntries: [],
              excludedEntries: [],
              liveInboxCount: inboxes.length,
              knownLiveInboxCount,
              artifactDir,
              stateDir,
              rootEmail,
              recoverySourceError: String(error?.message ?? error),
            };
          }
        } catch {
          // preserve original bootstrap error below
        }
      }
      return {
        ok: false,
        reason: String(error?.message ?? error),
        createdEntries: [],
        excludedEntries: [],
        artifactDir,
        stateDir,
        rootEmail,
      };
    } finally {
      await hooks.cleanup?.();
    }
  }

  return async function bootstrapKnownLineageRuntime({ lineage, ownerAliasId, ownerEmail, workspaceId, workspaceName = null, knownPoolEntries = [] } = {}) {
    const reinstatableEntries = await Promise.resolve(reinstatableEntriesProvider({
      lineage,
      ownerAliasId,
      ownerEmail,
      workspaceId,
      workspaceName,
      knownPoolEntries,
    }));
    const reinstated = await filterUsablePoolEntries(reinstatableEntries ?? [], { verifyEntry: verifyProvisionedEntry });
    if (reinstated.createdEntries.length > 0) {
      return {
        ok: true,
        reason: 'bootstrap-reinstated-archived-capacity',
        createdEntries: reinstated.createdEntries,
        excludedEntries: reinstated.excludedEntries,
        reinstatedCapacity: reinstated.createdEntries.length,
        liveInboxCount: 0,
        knownLiveInboxCount: 0,
        registryUpdates: {},
      };
    }

    const supplyRootCandidates = [...new Set(
      (knownPoolEntries ?? [])
        .filter((entry) => entry?.rootEmail && entry.rootApiKey)
        .filter((entry) => !lineage || entry.lineage === lineage || entry.workspaceGroupKey === lineage)
        .filter((entry) => !workspaceId || !entry.workspaceId || entry.workspaceId === workspaceId || entry.rootOrgId === workspaceId)
        .map((entry) => entry.rootEmail)
        .filter((rootEmail) => rootEmail && rootEmail !== ownerEmail),
    )];

    for (const supplyRootEmail of supplyRootCandidates) {
      const supplyRootResult = await attemptBootstrapForRoot({
        rootEmail: supplyRootEmail,
        lineage,
        ownerAliasId,
        workspaceId,
        workspaceName,
        knownPoolEntries,
        reasonContext: 'supply-root',
      });
      if (supplyRootResult.ok === true) {
        return {
          ...supplyRootResult,
          excludedEntries: [...reinstated.excludedEntries, ...(supplyRootResult.excludedEntries ?? [])],
          registryUpdates: supplyRootResult.registryUpdates ?? {},
        };
      }
    }

    if (!ownerEmail) {
      return {
        ok: false,
        reason: 'bootstrap-owner-email-missing',
        createdEntries: [],
        excludedEntries: reinstated.excludedEntries,
        registryUpdates: {},
      };
    }

    const currentRootResult = await attemptBootstrapForRoot({
      rootEmail: ownerEmail,
      lineage,
      ownerAliasId,
      workspaceId,
      workspaceName,
      knownPoolEntries,
      reasonContext: 'current-root',
    });

    if (currentRootResult.ok === true || allowFreshRootEscalation !== true) {
      return {
        ...currentRootResult,
        excludedEntries: [...reinstated.excludedEntries, ...(currentRootResult.excludedEntries ?? [])],
        registryUpdates: currentRootResult.registryUpdates ?? {},
      };
    }

    if (!new Set(['bootstrap-live-inboxes-already-known', 'bootstrap-created-no-usable-pool-entries']).has(currentRootResult.reason)) {
      return {
        ...currentRootResult,
        excludedEntries: [...reinstated.excludedEntries, ...(currentRootResult.excludedEntries ?? [])],
        registryUpdates: currentRootResult.registryUpdates ?? {},
      };
    }

    const freshRootEmail = createCandidateRootEmail({
      lineage,
      ownerAliasId,
      workspaceId,
      workspaceName,
      now,
    });
    const escalatedResult = await attemptBootstrapForRoot({
      rootEmail: freshRootEmail,
      lineage,
      ownerAliasId,
      workspaceId,
      workspaceName,
      knownPoolEntries,
      reasonContext: 'fresh-root',
    });

    return {
      ...escalatedResult,
      reason: escalatedResult.ok === true ? 'bootstrap-escalated-new-root' : escalatedResult.reason,
      excludedEntries: [
        ...reinstated.excludedEntries,
        ...(currentRootResult.excludedEntries ?? []),
        ...(escalatedResult.excludedEntries ?? []),
      ],
      escalationSourceReason: currentRootResult.reason,
      previousAttempt: {
        rootEmail: currentRootResult.rootEmail ?? ownerEmail,
        reason: currentRootResult.reason ?? null,
      },
      registryUpdates: escalatedResult.ok === true
        ? {
            usableSupplyRoots: [buildUsableSupplyRootRecord({
              rootEmail: freshRootEmail,
              lineage,
              workspaceId,
              workspaceName,
              ownerAliasId,
              now,
            })],
          }
        : (escalatedResult.registryUpdates ?? {}),
    };
  };
}

export async function prepareLiveFixRuntime({
  routerData = {},
  healthData = {},
  poolData = {},
  authData = {},
  registry = {},
  workspaceOwnerEmail = null,
  forceReplaceAll9 = false,
  resolveLineage = resolveExhaustedAliasLineage,
  bootstrapCapacity = bootstrapRuntimeCapacity,
  bootstrapLineage,
} = {}) {
  const exhaustedAliases = collectRuntimeExhaustedAliases({
    routerData,
    healthData,
    workspaceOwnerEmail,
    forceReplaceAll9,
  });

  const lineageResolution = await resolveLineage({
    exhaustedAliases,
    auth: authData,
    registry,
  });

  const resolvedAliases = (lineageResolution.resolved ?? []).map((item) => ({
    aliasId: item.aliasId,
    email: item.email,
    lineage: item.lineage,
    workspaceId: item.workspaceId,
    ownerAliasId: item.ownerAliasId,
    ownerEmail: item.ownerEmail,
    placementContext: item.placementContext,
  }));
  const unresolvedAliases = lineageResolution.unresolved ?? [];

  const initialUsableCapacity = countUsableEntries(poolData);
  const demand = resolvedAliases.length;
  const bootstrapResult = await bootstrapCapacity({
    pool: poolData,
    exhaustedDemand: demand,
    registry,
    preferredLineages: [...new Set(resolvedAliases.map((item) => item.lineage).filter(Boolean))],
    bootstrapLineage,
  });

  const createdEntries = bootstrapResult.createdEntries ?? [];
  const usableCapacityAfterBootstrap = initialUsableCapacity + createdEntries.length;
  const canProceed = demand === 0 || usableCapacityAfterBootstrap >= demand;

  return {
    exhaustedAliases,
    resolvedAliases,
    unresolvedAliases,
    skippedAliasIds: unresolvedAliases.map((item) => item.aliasId).filter(Boolean),
    allowedAliasIds: resolvedAliases.map((item) => item.aliasId).filter(Boolean),
    placementContextByAliasId: Object.fromEntries(resolvedAliases.map((item) => [item.aliasId, item.placementContext])),
    bootstrapResult,
    usableCapacityBeforeBootstrap: initialUsableCapacity,
    usableCapacityAfterBootstrap,
    canProceed,
  };
}
