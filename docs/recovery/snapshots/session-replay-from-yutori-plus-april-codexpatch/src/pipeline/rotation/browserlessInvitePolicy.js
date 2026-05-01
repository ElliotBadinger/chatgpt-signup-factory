function normalizeEmail(email = null) {
  return String(email ?? '').trim().toLowerCase();
}

export function findInviteByEmail(invites = [], email = null) {
  const normalized = normalizeEmail(email);
  return (invites ?? []).find((invite) => normalizeEmail(invite?.email_address) === normalized) ?? null;
}

export function findErroredInviteEmail(inviteResponse = null, email = null) {
  const normalized = normalizeEmail(email);
  return (inviteResponse?.errored_emails ?? []).find((entry) => normalizeEmail(entry?.email_address) === normalized) ?? null;
}

export function selectOldestPrunableInvite(invites = [], { excludeEmail = null } = {}) {
  const excluded = normalizeEmail(excludeEmail);
  return [...(invites ?? [])]
    .filter((invite) => normalizeEmail(invite?.email_address) !== excluded)
    .sort((left, right) => new Date(left?.created_time ?? 0).getTime() - new Date(right?.created_time ?? 0).getTime())[0] ?? null;
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
    const oldestInvite = selectOldestPrunableInvite(invites?.items ?? [], { excludeEmail: email });
    if (!oldestInvite?.id) {
      break;
    }

    prunedInvite = oldestInvite;
    log(`[browserlessInvitePolicy] pruning invite ${oldestInvite.id} (${oldestInvite.email_address ?? 'unknown-email'}) to retry ${email} in ${workspaceId}`);
    await cancelInvite(workspaceId, oldestInvite.id);
  }

  return {
    action: prunedInvite ? 'pruned-but-still-errored' : 'create-errored',
    invite: null,
    createdInvite: lastCreatedInvite,
    prunedInvite,
    erroredInvite: lastErroredInvite,
    attempts: maxCreateAttempts,
  };
}