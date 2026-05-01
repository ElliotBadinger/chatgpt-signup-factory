import path from 'node:path';

import { writeHandoffBundle as defaultWriteHandoffBundle } from '../evidence/handoff.js';
import { selectNextController, selectNextTarget } from '../shared/selection.js';
import { assertTargetTransition } from '../shared/transitions.js';
import { createPipelineStore } from '../state/store.js';

function buildDefaultArtifactDir({ stateDir, target }) {
  return path.join(stateDir ?? '.', 'artifacts', 'consume', target.id);
}

function buildHandoffPayload({ artifactDir, target, inviter, inviteLink, proofPaths, status }) {
  const runId = path.basename(artifactDir);

  return {
    target: target.id,
    inviter: inviter.id,
    inviteLink,
    proofPaths,
    status,
    resumeCommand: `node src/pipeline/consume/runConsume.js --artifact-dir ${artifactDir}`,
    statusCommand: `node src/pipeline/consume/runConsume.js --status --run-id ${runId}`,
  };
}

function mergeProofPaths(...pathSets) {
  return pathSets.flatMap((value) => (Array.isArray(value) ? value : [])).filter(Boolean);
}

const RESUME_TARGET_STATUS_PRIORITY = new Map([
  ['joined', 0],
  ['auth-started', 1],
  ['invite-received', 2],
  ['invite-sent', 3],
  ['pending', 4],
]);

function selectConsumableTarget(targets, fallbackSelectTarget) {
  const resumableTargets = targets
    .filter((target) => RESUME_TARGET_STATUS_PRIORITY.has(target.status))
    .slice()
    .sort((left, right) => {
      const priorityDifference = RESUME_TARGET_STATUS_PRIORITY.get(left.status) - RESUME_TARGET_STATUS_PRIORITY.get(right.status);
      if (priorityDifference !== 0) {
        return priorityDifference;
      }

      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

  if (resumableTargets.length > 0) {
    return resumableTargets[0];
  }

  return fallbackSelectTarget(targets);
}

function normalizeFinalStatus({ target, inviteResult, mailboxResult, onboardingResult, proofResult }) {
  const candidates = [proofResult?.status, onboardingResult?.status, mailboxResult?.status, inviteResult?.status, target?.status];
  return candidates.includes('proven') ? 'proven' : 'invited';
}

function findWorkspaceObservation(workspaceObservations, workspaceId) {
  if (!workspaceId) {
    return undefined;
  }

  const matching = workspaceObservations.filter((observation) => observation.workspaceId === workspaceId);
  if (matching.length === 0) {
    return undefined;
  }

  return matching
    .slice()
    .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0))[0];
}

async function recordTargetTransition({ store, at, target, toStatus, metadata }) {
  assertTargetTransition(target.status, toStatus);

  const nextTarget = {
    ...target,
    status: toStatus,
    updatedAt: at,
  };

  if (toStatus === 'invited') {
    nextTarget.invitedAt = at;
  }

  await store.upsertTarget(nextTarget);
  await store.appendRunEvent({
    at,
    stage: 'consume',
    entity_type: 'target',
    entity_id: target.id,
    from_status: target.status,
    to_status: toStatus,
    metadata,
  });

  return nextTarget;
}

export async function runConsume({
  stateDir,
  store = stateDir ? createPipelineStore({ stateDir }) : undefined,
  now = () => new Date().toISOString(),
  selectTarget = selectNextTarget,
  selectInviter = selectNextController,
  writeHandoffBundle = defaultWriteHandoffBundle,
  artifactDir,
  issueInvite = async ({ target, inviter }) => ({
    status: 'invited',
    inviteLink: `https://placeholder.invalid/invite/${target.id}?inviter=${inviter.id}`,
    proofPaths: [],
  }),
  pollMailbox = async () => ({ status: 'invited', proofPaths: [] }),
  runOnboarding = async () => ({ status: 'invited', proofPaths: [] }),
  collectProof = async () => ({ status: 'invited', proofPaths: [] }),
} = {}) {
  if (!store) {
    throw new TypeError('runConsume requires either a store or stateDir');
  }

  const [targets, inviters, workspaceObservations] = await Promise.all([
    store.listTargets(),
    store.listInviters(),
    store.listWorkspaceObservations(),
  ]);

  const target = selectConsumableTarget(targets, selectTarget);
  if (!target) {
    return { status: 'idle', reason: 'no_target_available' };
  }

  const inviter = selectInviter(inviters);
  if (!inviter) {
    return { status: 'idle', reason: 'no_inviter_available', target };
  }

  const timestamp = now();
  const workspaceId = target.workspaceId ?? inviter.workspaceId;
  const resolvedArtifactDir = artifactDir ?? buildDefaultArtifactDir({ stateDir, target });
  const transitionMetadata = {
    inviterId: inviter.id,
    ...(workspaceId ? { workspaceId } : {}),
  };

  const shouldSelectPendingTarget = target.status === 'pending';
  let currentTarget = target;

  if (shouldSelectPendingTarget) {
    currentTarget = await recordTargetTransition({
      store,
      at: timestamp,
      target,
      toStatus: 'selected',
      metadata: transitionMetadata,
    });
  }

  const workspaceObservation = findWorkspaceObservation(workspaceObservations, workspaceId);

  if (workspaceObservation?.hardCapReached) {
    currentTarget = await recordTargetTransition({
      store,
      at: timestamp,
      target: currentTarget,
      toStatus: 'skipped',
      metadata: {
        ...transitionMetadata,
        reason: 'hard_seat_cap_active',
        observedAt: workspaceObservation.observedAt,
      },
    });

    const handoff = buildHandoffPayload({
      artifactDir: resolvedArtifactDir,
      target: currentTarget,
      inviter,
      inviteLink: '',
      proofPaths: [],
      status: 'blocked',
    });

    await writeHandoffBundle(resolvedArtifactDir, handoff);

    return {
      status: 'blocked',
      target: currentTarget,
      inviter,
      artifactDir: resolvedArtifactDir,
      inviteLink: '',
      proofPaths: [],
      workspaceObservation,
    };
  }

  let inviteResult;
  if (currentTarget.status === 'pending' || currentTarget.status === 'selected') {
    inviteResult = await issueInvite({ target: currentTarget, inviter, store, workspaceObservation });

    currentTarget = await recordTargetTransition({
      store,
      at: timestamp,
      target: currentTarget,
      toStatus: 'invited',
      metadata: {
        ...transitionMetadata,
        inviteLink: inviteResult?.inviteLink ?? currentTarget.inviteLink ?? '',
      },
    });
  }

  let mailboxResult;
  if (!new Set(['invite-received', 'auth-started', 'joined', 'proven']).has(currentTarget.status)) {
    mailboxResult = await pollMailbox({ target: currentTarget, inviter, store, inviteResult });
  }

  let onboardingResult;
  if (!new Set(['joined', 'proven']).has(currentTarget.status)) {
    onboardingResult = await runOnboarding({ target: currentTarget, inviter, store, inviteResult, mailboxResult });
  }

  let proofResult;
  if (currentTarget.status !== 'proven') {
    proofResult = await collectProof({
      target: currentTarget,
      inviter,
      store,
      inviteResult,
      mailboxResult,
      onboardingResult,
    });
  }

  const finalStatus = normalizeFinalStatus({ target: currentTarget, inviteResult, mailboxResult, onboardingResult, proofResult });
  const proofPaths = mergeProofPaths(inviteResult?.proofPaths, mailboxResult?.proofPaths, onboardingResult?.proofPaths, proofResult?.proofPaths);

  if (finalStatus === 'proven' && currentTarget.status !== 'proven') {
    if (currentTarget.status === 'invited' || currentTarget.status === 'accepted') {
      currentTarget = await recordTargetTransition({
        store,
        at: timestamp,
        target: currentTarget,
        toStatus: 'proven',
        metadata: {
          ...transitionMetadata,
          inviteLink: inviteResult?.inviteLink ?? currentTarget.inviteLink ?? '',
        },
      });
    } else {
      currentTarget = {
        ...currentTarget,
        status: 'proven',
        updatedAt: timestamp,
      };
      await store.upsertTarget(currentTarget);
      await store.appendRunEvent({
        at: timestamp,
        stage: 'consume',
        entity_type: 'target',
        entity_id: currentTarget.id,
        from_status: target.status,
        to_status: 'proven',
        metadata: {
          ...transitionMetadata,
          inviteLink: inviteResult?.inviteLink ?? currentTarget.inviteLink ?? '',
          resumedFrom: target.status,
        },
      });
    }
  }

  await store.upsertInviter({
    ...inviter,
    status: inviter.status === 'ready' ? 'active' : inviter.status,
    successfulInviteCount: (inviter.successfulInviteCount ?? 0) + 1,
    updatedAt: timestamp,
  });

  const handoff = buildHandoffPayload({
    artifactDir: resolvedArtifactDir,
    target: currentTarget,
    inviter,
    inviteLink: inviteResult?.inviteLink ?? '',
    proofPaths,
    status: finalStatus,
  });

  await writeHandoffBundle(resolvedArtifactDir, handoff);

  return {
    status: finalStatus,
    target: currentTarget,
    inviter,
    artifactDir: resolvedArtifactDir,
    inviteLink: inviteResult?.inviteLink ?? '',
    proofPaths,
    outputs: {
      inviteIssue: inviteResult,
      mailboxPoll: mailboxResult,
      onboarding: onboardingResult,
      proof: proofResult,
    },
  };
}
