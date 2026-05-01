import fs from 'node:fs';
import path from 'node:path';

import { classifyBlockerReason } from './lifecycleModel.js';

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicWrite(filePath, value) {
  ensureDir(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function toIsoDate(value = Date.now()) {
  if (typeof value === 'string' && value.trim()) return value;
  return new Date(value).toISOString();
}

function buildLifecycleTransitions(details = [], writtenAt) {
  const transitions = [];

  for (const detail of details) {
    if (!detail?.aliasId) continue;

    if (detail.status === 'awaiting-reinstatement') {
      transitions.push({
        aliasId: detail.aliasId,
        fromState: 'active',
        toState: 'queued-replacement',
        occurredAt: writtenAt,
        metadata: {
          archivedReason: detail.archivedReason ?? null,
          groupKey: detail.groupKey ?? null,
        },
      });
      continue;
    }

    if (detail.status === 'reinstated') {
      transitions.push({
        aliasId: detail.aliasId,
        fromState: 'archived',
        toState: 'active',
        event: 'reinstated',
        occurredAt: writtenAt,
        metadata: null,
      });
      continue;
    }

    if (detail.status === 'rotated' && detail.newAliasId) {
      transitions.push({
        aliasId: detail.aliasId,
        fromState: 'active',
        toState: 'archived',
        occurredAt: writtenAt,
        metadata: {
          replacementAliasId: detail.newAliasId,
          inbox: detail.inbox ?? null,
        },
      });
      transitions.push({
        aliasId: detail.newAliasId,
        fromState: 'candidate',
        toState: 'active',
        occurredAt: writtenAt,
        metadata: {
          replacedAliasId: detail.aliasId,
          inbox: detail.inbox ?? null,
        },
      });
    }
  }

  return transitions;
}

function buildBlockerOutcomes(details = [], artifactPaths = {}) {
  return details
    .filter((detail) => detail?.status === 'failed' || detail?.blockerReason)
    .map((detail) => {
      const rawReason = String(detail.blockerReason ?? detail.error ?? detail.reason ?? 'unknown');
      const normalized = classifyBlockerReason(rawReason);
      return {
        aliasId: detail.aliasId ?? null,
        blockerClass: normalized.blockerClass,
        rawReason: normalized.rawReason,
        severity: 'error',
        supportingEvidence: Object.values(artifactPaths).filter(Boolean),
      };
    });
}

function buildRollbackOutcomes(details = [], writtenAt) {
  return details
    .filter((detail) => detail?.status === 'failed' && typeof detail?.error === 'string')
    .filter((detail) => detail.error.includes('finalize:') || detail.error.includes('verification:'))
    .map((detail) => ({
      aliasId: detail.aliasId ?? null,
      outcome: 'rollback-required',
      reason: detail.error,
      occurredAt: writtenAt,
    }));
}

function buildFrictionPoints(details = [], artifactPaths = {}, writtenAt) {
  return details
    .filter((detail) => detail?.status === 'failed' || detail?.status === 'protected-codex-lb' || detail?.status === 'awaiting-reinstatement')
    .map((detail) => {
      const rawReason = String(detail.blockerReason ?? detail.error ?? detail.reason ?? detail.status ?? 'unknown');
      const normalized = classifyBlockerReason(rawReason);
      return {
        aliasId: detail.aliasId ?? null,
        workspaceId: detail.targetWorkspaceId ?? null,
        blockerClass: normalized.blockerClass,
        rawReason: normalized.rawReason,
        surface: detail.status ?? 'unknown',
        occurredAt: writtenAt,
        supportingEvidence: Object.values(artifactPaths).filter(Boolean),
      };
    });
}

export function buildCanonicalRunArtifact({
  summary,
  artifactPaths = {},
  writtenAt = new Date().toISOString(),
} = {}) {
  return {
    lifecycleTransitions: buildLifecycleTransitions(summary?.details ?? [], writtenAt),
    blockerOutcomes: buildBlockerOutcomes(summary?.details ?? [], artifactPaths),
    rollbackOutcomes: buildRollbackOutcomes(summary?.details ?? [], writtenAt),
    supportingEvidence: artifactPaths,
    frictionPoints: buildFrictionPoints(summary?.details ?? [], artifactPaths, writtenAt),
    writtenAt,
  };
}

export function writeCanonicalRunArtifact({
  runDir,
  summary,
  artifactPaths = {},
  writtenAt = new Date().toISOString(),
} = {}) {
  const canonicalRunArtifactPath = path.join(runDir, 'canonical-run-artifact.json');
  const artifact = buildCanonicalRunArtifact({
    summary,
    artifactPaths,
    writtenAt,
  });
  atomicWrite(canonicalRunArtifactPath, artifact);
  return {
    canonicalRunArtifactPath,
    artifact,
  };
}

export function updateFrictionLedger({
  ledgerPath,
  frictionPoints = [],
  runId = null,
  writtenAt = new Date().toISOString(),
} = {}) {
  const existing = readJson(ledgerPath, { version: 1, entries: [] });
  const entries = Array.isArray(existing.entries) ? existing.entries : [];
  const nextEntries = [...entries];

  for (const point of frictionPoints) {
    const key = [
      point.blockerClass ?? '',
      point.rawReason ?? '',
      point.aliasId ?? '',
      point.workspaceId ?? '',
      point.surface ?? '',
    ].join('::');
    const existingIndex = nextEntries.findIndex((entry) => entry.key === key);

    if (existingIndex >= 0) {
      nextEntries[existingIndex] = {
        ...nextEntries[existingIndex],
        lastSeenAt: writtenAt,
        latestRunId: runId,
        latestEvidencePath: point.supportingEvidence?.[0] ?? nextEntries[existingIndex].latestEvidencePath ?? null,
        timesSeen: Number(nextEntries[existingIndex].timesSeen ?? 0) + 1,
      };
      continue;
    }

    nextEntries.push({
      key,
      firstSeenAt: writtenAt,
      lastSeenAt: writtenAt,
      latestRunId: runId,
      latestEvidencePath: point.supportingEvidence?.[0] ?? null,
      timesSeen: 1,
      blockerClass: point.blockerClass,
      rawReason: point.rawReason,
      aliasId: point.aliasId ?? null,
      workspaceId: point.workspaceId ?? null,
      surface: point.surface ?? null,
    });
  }

  const ledger = {
    version: 1,
    updatedAt: writtenAt,
    entries: nextEntries,
  };
  atomicWrite(ledgerPath, ledger);
  return ledger;
}