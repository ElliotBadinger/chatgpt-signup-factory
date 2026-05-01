import { isLastOwnerRemovalError, isWorkspaceDeactivatedError } from './browserlessWorkspaceClient.js';

const OWNER_ROLES = new Set(['account-owner', 'owner', 'workspace-owner']);

function deactivatedSkipItem(alias = {}, workspace = {}, error = null, phase = 'listUsers') {
  return {
    aliasId: alias.aliasId ?? null,
    email: alias.email ?? null,
    workspaceId: workspace.workspaceId ?? null,
    workspaceName: workspace.workspaceName ?? null,
    ownerAliasId: workspace.ownerAliasId ?? null,
    reason: 'workspace-deactivated',
    phase,
    error: error ? String(error?.message ?? error) : null,
  };
}

function isOwnerRole(role = null) {
  return OWNER_ROLES.has(String(role ?? '').toLowerCase());
}

function ownerProtectedSkipItem(alias = {}, workspace = {}, member = null, { phase = 'listUsers', reason = 'owner-protected', error = null, ownerCount = null } = {}) {
  return {
    aliasId: alias.aliasId ?? null,
    email: alias.email ?? null,
    workspaceId: workspace.workspaceId ?? null,
    workspaceName: workspace.workspaceName ?? null,
    ownerAliasId: workspace.ownerAliasId ?? null,
    reason,
    phase,
    role: member?.role ?? null,
    ownerCount,
    error: error ? String(error?.message ?? error) : null,
  };
}

export async function preRemoveExhaustedMembers({
  exhaustedAliases = [],
  resolveWorkspace,
  teamDriver,
  log = () => {},
} = {}) {
  if (typeof resolveWorkspace !== 'function') {
    throw new Error('preRemoveExhaustedMembers requires resolveWorkspace');
  }
  if (!teamDriver?.listUsers || !teamDriver?.removeTeamMember) {
    throw new Error('preRemoveExhaustedMembers requires teamDriver.listUsers and teamDriver.removeTeamMember');
  }

  const grouped = new Map();
  const skipped = [];

  for (const alias of exhaustedAliases) {
    try {
      const workspace = await resolveWorkspace(alias);
      if (!workspace?.workspaceId) {
        skipped.push({ aliasId: alias.aliasId ?? null, email: alias.email ?? null, reason: 'workspace-unresolved' });
        continue;
      }
      const list = grouped.get(workspace.workspaceId) ?? { workspace, aliases: [] };
      list.aliases.push(alias);
      grouped.set(workspace.workspaceId, list);
    } catch (error) {
      skipped.push({
        aliasId: alias.aliasId ?? null,
        email: alias.email ?? null,
        reason: 'workspace-unresolved',
        error: String(error?.message ?? error),
      });
    }
  }

  const removed = [];
  for (const { workspace, aliases } of grouped.values()) {
    let users;
    try {
      users = await teamDriver.listUsers(workspace.workspaceId, { workspace, placementContext: null });
    } catch (error) {
      if (isWorkspaceDeactivatedError(error)) {
        for (const alias of aliases) {
          skipped.push(deactivatedSkipItem(alias, workspace, error, 'listUsers'));
        }
        log(`[preRemoveExhaustedMembers] skipped deactivated workspace ${workspace.workspaceId} during listUsers`);
        continue;
      }
      throw error;
    }

    const userItems = users.items ?? [];
    const byEmail = new Map(userItems.map((user) => [String(user.email ?? '').toLowerCase(), user]));
    const ownerCount = userItems.filter((user) => isOwnerRole(user?.role)).length;
    for (let index = 0; index < aliases.length; index += 1) {
      const alias = aliases[index];
      const email = String(alias.email ?? '').toLowerCase();
      const member = byEmail.get(email);
      if (!member?.id) {
        skipped.push({ aliasId: alias.aliasId ?? null, email: alias.email ?? null, workspaceId: workspace.workspaceId, reason: 'not-found' });
        continue;
      }
      if (isOwnerRole(member.role)) {
        const reason = ownerCount <= 1 ? 'last-owner-protected' : 'owner-protected';
        skipped.push(ownerProtectedSkipItem(alias, workspace, member, { phase: 'listUsers', reason, ownerCount }));
        log(`[preRemoveExhaustedMembers] skipped owner ${alias.email} in ${workspace.workspaceId} during listUsers (${reason})`);
        continue;
      }
      try {
        await teamDriver.removeTeamMember(alias.email, {
          workspace,
          placementContext: alias.placementContext ?? {
            aliasId: alias.aliasId ?? null,
            aliasEmail: alias.email ?? null,
            lineage: alias.lineage ?? alias.workspaceLineage ?? null,
            workspaceId: alias.workspaceId ?? workspace.workspaceId ?? null,
          },
        });
      } catch (error) {
        if (isWorkspaceDeactivatedError(error)) {
          for (const remainingAlias of aliases.slice(index)) {
            skipped.push(deactivatedSkipItem(remainingAlias, workspace, error, 'removeTeamMember'));
          }
          log(`[preRemoveExhaustedMembers] skipped deactivated workspace ${workspace.workspaceId} during removeTeamMember`);
          break;
        }
        if (isLastOwnerRemovalError(error)) {
          skipped.push(ownerProtectedSkipItem(alias, workspace, member, {
            phase: 'removeTeamMember',
            reason: 'last-owner-protected',
            ownerCount,
            error,
          }));
          log(`[preRemoveExhaustedMembers] skipped owner ${alias.email} in ${workspace.workspaceId} during removeTeamMember (last-owner-protected)`);
          continue;
        }
        throw error;
      }
      removed.push({ aliasId: alias.aliasId ?? null, email: alias.email ?? null, workspaceId: workspace.workspaceId, userId: member.id });
      log(`[preRemoveExhaustedMembers] removed ${alias.email} from ${workspace.workspaceId}`);
    }
  }

  return {
    groupedWorkspaceCount: grouped.size,
    removed,
    skipped,
  };
}
