function normalizeEmail(email = null) {
  return String(email ?? '').trim().toLowerCase();
}

function inviteEmail(invite = null) {
  return invite?.email_address ?? invite?.email ?? null;
}

function normalizeStatusValue(status = null) {
  return String(status ?? '').trim().toLowerCase();
}

export function normalizeInviteStatus(invite = null) {
  const rawStatus = invite?.status;
  if (typeof rawStatus === 'number' && Number.isFinite(rawStatus)) {
    return rawStatus === 2 ? 'pending' : 'unknown-active';
  }

  const status = normalizeStatusValue(rawStatus);
  if (!status) {
    return 'unknown-active';
  }
  if (status === 'canceled' || status === 'cancelled') {
    return 'cancelled';
  }
  if (status === 'pending' || status === 'expired' || status === 'accepted' || status === 'failed') {
    return status;
  }
  return 'unknown-active';
}

function isPendingInvite(invite = null) {
  return Boolean(invite?.id) && normalizeInviteStatus(invite) === 'pending';
}

function isTerminalInvite(invite = null) {
  const status = normalizeInviteStatus(invite);
  return status === 'cancelled' || status === 'expired' || status === 'accepted' || status === 'failed';
}

export function findInviteByEmail(invites = [], email = null) {
  const normalized = normalizeEmail(email);
  return (invites ?? []).find((invite) => normalizeEmail(inviteEmail(invite)) === normalized && isPendingInvite(invite)) ?? null;
}

export function findErroredInviteEmail(inviteResponse = null, email = null) {
  const normalized = normalizeEmail(email);
  return (inviteResponse?.errored_emails ?? []).find((entry) => normalizeEmail(inviteEmail(entry)) === normalized) ?? null;
}

export function selectOldestPrunableInvite(invites = [], { excludeEmail = null } = {}) {
  const excluded = normalizeEmail(excludeEmail);
  return [...(invites ?? [])]
    .filter((invite) => normalizeEmail(inviteEmail(invite)) !== excluded)
    .filter(isPendingInvite)
    .sort((left, right) => new Date(left?.created_time ?? 0).getTime() - new Date(right?.created_time ?? 0).getTime())[0] ?? null;
}

async function cancelAndVerifyInvite({ workspaceId, invite, listInvites, cancelInvite, log }) {
  await cancelInvite(workspaceId, invite.id);
  const afterCancel = await listInvites(workspaceId).catch((error) => {
    log(`[browserlessInvitePolicy] could not verify cancel for invite ${invite.id}: ${error?.message ?? error}`);
    return null;
  });
  if (!afterCancel) {
    return { cancelled: false, invites: null };
  }
  const stillActive = (afterCancel?.items ?? []).some((candidate) => candidate.id === invite.id && !isTerminalInvite(candidate));
  if (stillActive) {
    log(`[browserlessInvitePolicy] invite ${invite.id} still active after cancel response`);
    return { cancelled: false, invites: afterCancel };
  }
  return { cancelled: true, invites: afterCancel };
}

export async function ensureWorkspaceInvite({
  workspaceId,
  email,
  listInvites,
  createInvite,
  cancelInvite,
  log = () => {},
  maxCreateAttempts = 2,
} = {}) {
  if (!workspaceId) throw new Error('ensureWorkspaceInvite requires workspaceId');
  if (!email) throw new Error('ensureWorkspaceInvite requires email');
  if (typeof listInvites !== 'function') throw new Error('ensureWorkspaceInvite requires listInvites');
  if (typeof createInvite !== 'function') throw new Error('ensureWorkspaceInvite requires createInvite');
  if (typeof cancelInvite !== 'function') throw new Error('ensureWorkspaceInvite requires cancelInvite');

  let invites = await listInvites(workspaceId).catch(() => ({ items: [] }));
  const existingInvite = findInviteByEmail(invites?.items ?? [], email);
  if (existingInvite?.id) {
    log(`[browserlessInvitePolicy] reusing existing invite for ${email} in ${workspaceId}: ${existingInvite.id}`);
    return {
      action: 'reused-existing',
      invite: existingInvite,
      createdInvite: null,
      prunedInvite: null,
      attempts: 0,
    };
  }

  const failedPrunes = [];
  let lastCreatedInvite = null;
  let lastErroredInvite = null;
  let prunedInvite = null;

  for (let attemptIndex = 1; attemptIndex <= maxCreateAttempts; attemptIndex += 1) {
    lastCreatedInvite = await createInvite(workspaceId, email);
    log(`[browserlessInvitePolicy] create invite attempt ${attemptIndex} for ${email} in ${workspaceId}: ${JSON.stringify(lastCreatedInvite)}`);
    lastErroredInvite = findErroredInviteEmail(lastCreatedInvite, email);
    if (!lastErroredInvite) {
      return {
        action: prunedInvite ? 'pruned-and-created' : 'created',
        invite: findInviteByEmail(lastCreatedInvite?.account_invites ?? [], email),
        createdInvite: lastCreatedInvite,
        prunedInvite,
        attempts: attemptIndex,
      };
    }

    invites = await listInvites(workspaceId).catch(() => ({ items: [] }));
    const oldestInvite = selectOldestPrunableInvite(
      (invites?.items ?? []).filter((invite) => !failedPrunes.includes(invite?.id)),
      { excludeEmail: email },
    );
    if (!oldestInvite?.id) {
      break;
    }

    log(`[browserlessInvitePolicy] pruning invite ${oldestInvite.id} (${oldestInvite.email_address ?? 'unknown-email'}) to retry ${email} in ${workspaceId}`);
    const pruneResult = await cancelAndVerifyInvite({
      workspaceId,
      invite: oldestInvite,
      listInvites,
      cancelInvite,
      log,
    });
    if (pruneResult.cancelled) {
      prunedInvite = oldestInvite;
      invites = pruneResult.invites;
    } else {
      failedPrunes.push(oldestInvite.id);
    }
  }

  return {
    action: prunedInvite ? 'pruned-but-still-errored' : 'create-errored',
    invite: null,
    createdInvite: lastCreatedInvite,
    prunedInvite,
    failedPrunes,
    erroredInvite: lastErroredInvite,
    attempts: maxCreateAttempts,
  };
}
