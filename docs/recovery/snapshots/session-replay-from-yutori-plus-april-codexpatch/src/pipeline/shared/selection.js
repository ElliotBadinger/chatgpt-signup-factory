/**
 * Deterministic selection helpers for pipeline orchestration.
 * Pure, stateless — no I/O, no mutations of inputs.
 *
 * Sort rules are explicit and stable; they do not depend on input ordering.
 */

/** Statuses considered eligible for receiving new work. */
const CONTROLLER_ELIGIBLE_STATUSES = new Set(['ready', 'active']);

/**
 * Pick the next available controller that still has inbox capacity.
 *
 * Sort order (stable, deterministic):
 *   1. successfulInviteCount ascending (fewest invites first)
 *   2. id lexicographic ascending (tiebreaker)
 *
 * @param {Array<{id: string, status: string, successfulInviteCount?: number}>} records
 * @param {{ inboxCap?: number }} [options]
 * @returns {{ id: string, status: string, successfulInviteCount?: number } | undefined}
 */
export function selectNextController(records, options = {}) {
  const { inboxCap } = options;

  const eligible = records.filter((r) => {
    if (!CONTROLLER_ELIGIBLE_STATUSES.has(r.status)) return false;
    if (inboxCap !== undefined) {
      const count = r.successfulInviteCount ?? 0;
      if (count >= inboxCap) return false;
    }
    return true;
  });

  if (eligible.length === 0) return undefined;

  // Sort on a copy — never mutate the caller's slice
  const sorted = eligible.slice().sort((a, b) => {
    const countA = a.successfulInviteCount ?? 0;
    const countB = b.successfulInviteCount ?? 0;
    if (countA !== countB) return countA - countB;
    // tiebreaker: lexicographic id ascending
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return sorted[0];
}

/**
 * Pick the next unconsumed (pending) target deterministically.
 *
 * Sort order (stable, deterministic):
 *   1. id lexicographic ascending
 *
 * @param {Array<{id: string, status: string}>} records
 * @param {object} [options]   reserved for future use
 * @returns {{ id: string, status: string } | undefined}
 */
export function selectNextTarget(records, options = {}) {
  const pending = records.filter((r) => r.status === 'pending');

  if (pending.length === 0) return undefined;

  const sorted = pending.slice().sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  return sorted[0];
}
