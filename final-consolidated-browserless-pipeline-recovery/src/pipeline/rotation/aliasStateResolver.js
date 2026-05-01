import { normalizeInviteStatus } from './browserlessInvitePolicy.js';

const DEFAULT_START_INDEX = 2;
const DEFAULT_MAX_INDEX = 10_000;

function normalizeEmail(email = null) {
  return String(email ?? '').trim().toLowerCase();
}

function normalizeAliasId(aliasId = null) {
  return String(aliasId ?? '').trim().toLowerCase();
}

function buildAliasPattern(prefix) {
  return new RegExp(`^${prefix}_(\\d+)$`, 'i');
}

function resolveAliasIdentity({ prefix, domain, aliasId = null, email = null } = {}) {
  const normalizedDomain = String(domain ?? '').trim().toLowerCase();
  const normalizedAliasId = normalizeAliasId(aliasId);
  const normalizedEmail = normalizeEmail(email);
  const pattern = buildAliasPattern(prefix);

  if (normalizedEmail) {
    const [localPart, emailDomain = ''] = normalizedEmail.split('@');
    const match = pattern.exec(localPart ?? '');
    if (match && emailDomain === normalizedDomain) {
      return {
        aliasId: localPart.toLowerCase(),
        email: normalizedEmail,
        index: Number(match[1]),
      };
    }
  }

  const aliasMatch = pattern.exec(normalizedAliasId);
  if (aliasMatch) {
    return {
      aliasId: normalizedAliasId,
      email: `${normalizedAliasId}@${normalizedDomain}`,
      index: Number(aliasMatch[1]),
    };
  }

  return null;
}

function normalizeCollection(value = null) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.account_invites)) return value.account_invites;
  return [];
}

function isActiveInvite(invite = null) {
  const inviteId = invite?.id ?? invite?.invite_id ?? null;
  const status = normalizeInviteStatus(invite);
  return Boolean(inviteId) && (status === 'pending' || status === 'unknown-active');
}

function createAliasRecord(identity) {
  return {
    ...identity,
    state: null,
    safeToAllocate: false,
    sources: {
      router: false,
      auth: false,
      archive: false,
      workspaceMember: false,
      invite: false,
      codexLb: false,
    },
  };
}

function ensureAliasRecord(records, identity) {
  if (!identity) return null;
  const existing = records.get(identity.email);
  if (existing) return existing;
  const created = createAliasRecord(identity);
  records.set(identity.email, created);
  return created;
}

function classifyAliasState(record) {
  const {
    router,
    auth,
    archive,
    workspaceMember,
    invite,
    codexLb,
  } = record.sources;

  if (archive) return 'archived';
  if (invite) return 'pending-invite';
  if (workspaceMember && !router && !auth) return 'workspace-member-no-router';
  if (router && auth) return 'usable';
  if (router && !auth) return 'router-only';
  if (codexLb && !router && !auth && !workspaceMember) return 'codex-lb-only';
  if (!router && !auth && !archive && !workspaceMember && !invite && !codexLb) return 'safe-to-allocate';
  return 'unknown-live-state';
}

function finalizeAliasRecord(record) {
  const state = classifyAliasState(record);
  return {
    ...record,
    state,
    safeToAllocate: state === 'safe-to-allocate',
  };
}

export function resolveAliasStates({
  prefix,
  domain,
  router = null,
  auth = null,
  archive = null,
  workspaceMembers = [],
  invites = [],
  codexLbAccounts = [],
} = {}) {
  const records = new Map();

  for (const alias of router?.aliases ?? []) {
    const record = ensureAliasRecord(records, resolveAliasIdentity({
      prefix,
      domain,
      aliasId: alias?.id ?? alias?.aliasId ?? null,
      email: alias?.email ?? null,
    }));
    if (record) record.sources.router = true;
  }

  for (const aliasId of Object.keys(auth ?? {})) {
    const record = ensureAliasRecord(records, resolveAliasIdentity({
      prefix,
      domain,
      aliasId,
    }));
    if (record) record.sources.auth = true;
  }

  for (const entry of archive?.aliases ?? []) {
    if (entry?.reinstated === true) continue;
    const record = ensureAliasRecord(records, resolveAliasIdentity({
      prefix,
      domain,
      aliasId: entry?.aliasId ?? null,
      email: entry?.email ?? null,
    }));
    if (record) record.sources.archive = true;
  }

  for (const member of normalizeCollection(workspaceMembers)) {
    const record = ensureAliasRecord(records, resolveAliasIdentity({
      prefix,
      domain,
      email: typeof member === 'string'
        ? member
        : (member?.email ?? member?.email_address ?? null),
    }));
    if (record) record.sources.workspaceMember = true;
  }

  for (const invite of normalizeCollection(invites)) {
    if (!isActiveInvite(invite)) continue;
    const record = ensureAliasRecord(records, resolveAliasIdentity({
      prefix,
      domain,
      email: invite?.email_address ?? invite?.email ?? null,
    }));
    if (record) record.sources.invite = true;
  }

  for (const account of normalizeCollection(codexLbAccounts)) {
    const record = ensureAliasRecord(records, resolveAliasIdentity({
      prefix,
      domain,
      aliasId: account?.aliasId ?? null,
      email: account?.email ?? account?.accountEmail ?? null,
    }));
    if (record) record.sources.codexLb = true;
  }

  const aliases = [...records.values()]
    .map(finalizeAliasRecord)
    .sort((left, right) => left.index - right.index);

  return {
    aliases,
    byEmail: Object.fromEntries(aliases.map((record) => [record.email, record])),
  };
}

export function findNextSafeAlias({
  prefix,
  domain,
  router = null,
  auth = null,
  archive = null,
  workspaceMembers = [],
  invites = [],
  codexLbAccounts = [],
  startIndex = DEFAULT_START_INDEX,
  maxIndex = DEFAULT_MAX_INDEX,
} = {}) {
  const resolved = resolveAliasStates({
    prefix,
    domain,
    router,
    auth,
    archive,
    workspaceMembers,
    invites,
    codexLbAccounts,
  });

  for (let index = startIndex; index < maxIndex; index += 1) {
    const aliasId = `${prefix}_${index}`.toLowerCase();
    const email = `${aliasId}@${String(domain ?? '').trim().toLowerCase()}`;
    const existing = resolved.byEmail[email];
    if (!existing) {
      return finalizeAliasRecord(createAliasRecord({ aliasId, email, index }));
    }
    if (existing.safeToAllocate) {
      return existing;
    }
  }

  throw new Error(`Unable to allocate ${prefix}_N@${domain}`);
}
