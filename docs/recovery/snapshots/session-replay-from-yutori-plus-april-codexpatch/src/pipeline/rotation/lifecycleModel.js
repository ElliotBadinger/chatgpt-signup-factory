export const CANONICAL_ALIAS_LIFECYCLE_STATES = [
  'candidate',
  'active',
  'queued-replacement',
  'archived',
  'restorable',
  'quarantined',
];

export const LIFECYCLE_RESTORE_EVENT = 'reinstated';

export const CANONICAL_BLOCKER_CLASSES = [
  'workspace-identity-membership',
  'auth-durability',
  'reconcile-store-agreement',
  'verification-evidence',
  'capacity-quota',
  'ingress-onboarding',
];

const BLOCKER_REASON_CLASS_MAP = new Map([
  ['workspace-account-mismatch', 'workspace-identity-membership'],
  ['workspace-router-evidence-missing', 'workspace-identity-membership'],
  ['unofficial-workspace-member', 'workspace-identity-membership'],
  ['wrong-workspace-persistence', 'workspace-identity-membership'],
  ['missing-refresh-token', 'auth-durability'],
  ['non-durable-auth', 'auth-durability'],
  ['owned-oauth-account-mismatch', 'auth-durability'],
  ['store-disagreement', 'reconcile-store-agreement'],
  ['rollback-residue-detected', 'reconcile-store-agreement'],
  ['verification-probe-not-configured', 'verification-evidence'],
  ['workspace-account-evidence-missing', 'verification-evidence'],
  ['session-identity-evidence-missing', 'verification-evidence'],
  ['quota-evidence-ambiguous', 'capacity-quota'],
  ['quota-below-threshold', 'capacity-quota'],
  ['MEMBERSHIP_NOT_MATERIALIZED', 'ingress-onboarding'],
  ['no-email-code-option', 'ingress-onboarding'],
]);

function normalizeReason(rawReason) {
  return String(rawReason ?? '').trim();
}

export function isCanonicalAliasLifecycleState(value) {
  return CANONICAL_ALIAS_LIFECYCLE_STATES.includes(String(value ?? '').trim());
}

export function isCanonicalBlockerClass(value) {
  return CANONICAL_BLOCKER_CLASSES.includes(String(value ?? '').trim());
}

export function classifyBlockerReason(rawReason) {
  const reason = normalizeReason(rawReason);
  const lowerReason = reason.toLowerCase();

  if (!reason) {
    return {
      blockerClass: 'verification-evidence',
      rawReason: reason,
    };
  }

  const directMatch = BLOCKER_REASON_CLASS_MAP.get(reason) ?? BLOCKER_REASON_CLASS_MAP.get(lowerReason);
  if (directMatch) {
    return {
      blockerClass: directMatch,
      rawReason: reason,
    };
  }

  if (lowerReason.includes('workspace') || lowerReason.includes('membership') || lowerReason.includes('quarantine')) {
    return {
      blockerClass: 'workspace-identity-membership',
      rawReason: reason,
    };
  }

  if (lowerReason.includes('refresh') || lowerReason.includes('oauth') || lowerReason.includes('durable auth') || lowerReason.includes('session-only')) {
    return {
      blockerClass: 'auth-durability',
      rawReason: reason,
    };
  }

  if (lowerReason.includes('rollback') || lowerReason.includes('codex-lb') || lowerReason.includes('store disagreement') || lowerReason.includes('residue')) {
    return {
      blockerClass: 'reconcile-store-agreement',
      rawReason: reason,
    };
  }

  if (lowerReason.includes('verification') || lowerReason.includes('probe') || lowerReason.includes('evidence')) {
    return {
      blockerClass: 'verification-evidence',
      rawReason: reason,
    };
  }

  if (lowerReason.includes('quota') || lowerReason.includes('capacity') || lowerReason.includes('healthy floor')) {
    return {
      blockerClass: 'capacity-quota',
      rawReason: reason,
    };
  }

  return {
    blockerClass: 'ingress-onboarding',
    rawReason: reason,
  };
}

export function createOwnerAdminCleanupTarget({
  aliasId = null,
  email = null,
  workspaceId = null,
  reason = 'unofficial-workspace-member',
  source = 'workspace-owner-admin',
  status = 'scrub-candidate',
} = {}) {
  return {
    aliasId: aliasId ?? null,
    email: email ?? null,
    workspaceId: workspaceId ?? null,
    status,
    source,
    ...classifyBlockerReason(reason),
  };
}

export function createLifecycleTransition({
  aliasId,
  fromState,
  toState,
  event = null,
  occurredAt,
  metadata = null,
} = {}) {
  return {
    aliasId,
    fromState,
    toState,
    event,
    occurredAt,
    metadata,
  };
}