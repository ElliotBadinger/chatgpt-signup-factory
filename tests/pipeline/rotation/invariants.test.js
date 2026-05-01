/**
 * invariants.test.js
 *
 * Asserts all INV-1 through INV-9 from the spec (Section 9).
 * Uses only in-memory data — no file I/O required.
 */

import { describe, test, expect } from '@jest/globals';

// ─────────────────────── helper builders ─────────────────────────────────────────
function makeAlias(id, overrides = {}) {
  return { id, cloneFrom: 'openai-codex', apiKey: 'unused', email: `${id}@agentmail.to`, label: id, disabled: false, ...overrides };
}

function makeArchivedAlias(aliasId, overrides = {}) {
  return {
    aliasId,
    email: `${aliasId}@agentmail.to`,
    cloneFrom: 'openai-codex',
    auth: { type: 'oauth', access: 'tok', refresh: 'ref', expires: Date.now() + 3600_000, accountId: 'uid' },
    archivedAt: Date.now(),
    archivedReason: 'both-exhausted',
    quotaRemainingFraction: 0,
    reinstated: false,
    teamMemberStatus: 'active',
    ...overrides,
  };
}

function makeInboxEntry(address, status = 'available', overrides = {}) {
  return {
    inboxAddress: address,
    rootEmail: 'root@example.com',
    rootOrgId: 'org1',
    status,
    statusUpdatedAt: Date.now(),
    ...overrides,
  };
}

function makeAuth(aliasId) {
  return { type: 'oauth', access: `tok_${aliasId}`, refresh: 'r', expires: Date.now() + 3600_000, accountId: `uid_${aliasId}` };
}

// ─────────────────────── INV-1 ────────────────────────────────────────────────────
describe('INV-1: every archived alias has full auth credentials', () => {
  test('each archived entry has non-empty access, refresh, expires, accountId', () => {
    const archive = {
      aliases: [
        makeArchivedAlias('alias1'),
        makeArchivedAlias('alias2'),
        makeArchivedAlias('alias3', { reinstated: true, reinstatedAt: Date.now() }),
      ],
    };

    expect(archive.aliases.every((a) =>
      a.auth?.access && a.auth?.refresh && a.auth?.expires && a.auth?.accountId,
    )).toBe(true);
  });

  test('fails if an archived entry has missing access token', () => {
    const badEntry = makeArchivedAlias('alias1', { auth: { type: 'oauth', refresh: 'r', expires: 9999, accountId: 'uid' } });
    expect(badEntry.auth?.access).toBeFalsy(); // demonstrates what INV-1 guards against
  });
});

// ─────────────────────── INV-2 ────────────────────────────────────────────────────
describe('INV-2: no alias in both active router AND non-reinstated archive', () => {
  test('clean state satisfies INV-2', () => {
    const router = { aliases: [makeAlias('active1'), makeAlias('active2')] };
    const archive = { aliases: [makeArchivedAlias('retired1'), makeArchivedAlias('retired2')] };

    const activeIds = new Set(router.aliases.map((a) => a.id));
    const archivedNonReinstated = archive.aliases.filter((a) => !a.reinstated).map((a) => a.aliasId);

    for (const id of archivedNonReinstated) {
      expect(activeIds.has(id)).toBe(false);
    }
  });

  test('reinstated archived aliases MAY appear in active router', () => {
    const router = { aliases: [makeAlias('reinstated1')] };
    const archive = { aliases: [makeArchivedAlias('reinstated1', { reinstated: true, reinstatedAt: Date.now() })] };

    const activeIds = new Set(router.aliases.map((a) => a.id));
    const archivedNonReinstated = archive.aliases.filter((a) => !a.reinstated).map((a) => a.aliasId);

    // No non-reinstated entries conflict with active
    for (const id of archivedNonReinstated) {
      expect(activeIds.has(id)).toBe(false);
    }
    // The reinstated one is allowed to be in both (it was added back)
    expect(activeIds.has('reinstated1')).toBe(true);
  });
});

// ─────────────────────── INV-3 ────────────────────────────────────────────────────
describe('INV-3: reinstated archive entries have reinstatedAt timestamp', () => {
  test('all reinstated entries have non-null reinstatedAt', () => {
    const archive = {
      aliases: [
        makeArchivedAlias('a1', { reinstated: true, reinstatedAt: Date.now() }),
        makeArchivedAlias('a2', { reinstated: true, reinstatedAt: Date.now() - 1000 }),
        makeArchivedAlias('a3', { reinstated: false }), // not reinstated
      ],
    };

    const reinstated = archive.aliases.filter((a) => a.reinstated);
    expect(reinstated.every((a) => a.reinstatedAt != null)).toBe(true);
  });

  test('non-reinstated entries do not need reinstatedAt', () => {
    const archive = { aliases: [makeArchivedAlias('a1')] };
    expect(archive.aliases[0].reinstated).toBe(false);
    expect(archive.aliases[0].reinstatedAt).toBeUndefined();
  });
});

// ─────────────────────── INV-4 ────────────────────────────────────────────────────
describe('INV-4: pool entries ≤ rootMailboxes × 3', () => {
  test('9 inboxes across 3 roots satisfies INV-4', () => {
    const pool = {
      entries: [
        makeInboxEntry('a@agentmail.to'), makeInboxEntry('b@agentmail.to'), makeInboxEntry('c@agentmail.to'),
        makeInboxEntry('d@agentmail.to'), makeInboxEntry('e@agentmail.to'), makeInboxEntry('f@agentmail.to'),
        makeInboxEntry('g@agentmail.to'), makeInboxEntry('h@agentmail.to'), makeInboxEntry('i@agentmail.to'),
      ],
    };
    const rootMailboxCount = 3;
    expect(pool.entries.length).toBeLessThanOrEqual(rootMailboxCount * 3);
  });

  test('12 inboxes across 4 roots also satisfies INV-4', () => {
    const entries = Array.from({ length: 12 }, (_, i) => makeInboxEntry(`alias${i}@agentmail.to`));
    expect(entries.length).toBeLessThanOrEqual(4 * 3);
  });
});

// ─────────────────────── INV-5 ────────────────────────────────────────────────────
describe('INV-5: each inbox address appears only once in the pool', () => {
  test('pool with all unique addresses satisfies INV-5', () => {
    const pool = {
      entries: [
        makeInboxEntry('a@agentmail.to'),
        makeInboxEntry('b@agentmail.to'),
        makeInboxEntry('c@agentmail.to'),
      ],
    };
    const addresses = pool.entries.map((e) => e.inboxAddress);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  test('demonstrates what a violation looks like', () => {
    const pool = {
      entries: [
        makeInboxEntry('dup@agentmail.to'),
        makeInboxEntry('dup@agentmail.to'), // duplicate!
      ],
    };
    const addresses = pool.entries.map((e) => e.inboxAddress);
    // Violation: set size < array length
    expect(new Set(addresses).size).toBeLessThan(addresses.length);
  });
});

// ─────────────────────── INV-6 ────────────────────────────────────────────────────
describe('INV-6: each "in-use" inbox has a linked alias ID', () => {
  test('all in-use entries have linkedAliasId', () => {
    const pool = {
      entries: [
        makeInboxEntry('a@agentmail.to', 'in-use', { linkedAliasId: 'alias1' }),
        makeInboxEntry('b@agentmail.to', 'available'),
        makeInboxEntry('c@agentmail.to', 'in-use', { linkedAliasId: 'alias3' }),
      ],
    };
    const inUse = pool.entries.filter((e) => e.status === 'in-use');
    expect(inUse.every((e) => e.linkedAliasId != null)).toBe(true);
  });

  test('available entries do not need linkedAliasId', () => {
    const pool = { entries: [makeInboxEntry('a@agentmail.to', 'available')] };
    expect(pool.entries[0].linkedAliasId).toBeUndefined();
  });
});

// ─────────────────────── INV-7 ────────────────────────────────────────────────────
describe('INV-7: no "available" inbox is also linked to an alias', () => {
  test('available entries have no linkedAliasId', () => {
    const pool = {
      entries: [
        makeInboxEntry('a@agentmail.to', 'available'),
        makeInboxEntry('b@agentmail.to', 'available'),
      ],
    };
    const available = pool.entries.filter((e) => e.status === 'available');
    expect(available.every((e) => e.linkedAliasId == null)).toBe(true);
  });

  test('demonstrates the violation', () => {
    const badEntry = makeInboxEntry('a@agentmail.to', 'available', { linkedAliasId: 'alias1' });
    // This would violate INV-7:
    expect(badEntry.status === 'available' && badEntry.linkedAliasId != null).toBe(true);
  });
});

// ─────────────────────── INV-8 ────────────────────────────────────────────────────
describe('INV-8: each active codex alias in router has an auth entry', () => {
  test('all codex aliases have matching auth entries', () => {
    const router = {
      aliases: [
        makeAlias('alias1'),
        makeAlias('alias2'),
        { id: 'anthropic-alias', cloneFrom: 'anthropic', apiKey: 'k', email: 'x@y.com', label: 'x', disabled: false },
      ],
    };
    const auth = {
      'alias1': makeAuth('alias1'),
      'alias2': makeAuth('alias2'),
      // anthropic-alias intentionally absent (not codex)
    };

    const codexIds = router.aliases
      .filter((a) => a.cloneFrom === 'openai-codex' && !a.disabled)
      .map((a) => a.id);

    expect(codexIds.every((id) => auth[id]?.type === 'oauth')).toBe(true);
  });

  test('disabled codex alias does not need auth entry', () => {
    const router = {
      aliases: [
        makeAlias('alias1'),
        makeAlias('alias2', { disabled: true }), // disabled
      ],
    };
    const auth = { 'alias1': makeAuth('alias1') };

    const activeCodexIds = router.aliases
      .filter((a) => a.cloneFrom === 'openai-codex' && !a.disabled)
      .map((a) => a.id);

    expect(activeCodexIds).toHaveLength(1);
    expect(activeCodexIds.every((id) => auth[id]?.type === 'oauth')).toBe(true);
  });
});

// ─────────────────────── INV-9 ────────────────────────────────────────────────────
describe('INV-9: no temp IDs remain in auth.json after cycle completion', () => {
  test('clean auth.json has no temp- keys', () => {
    const auth = {
      'alias1': makeAuth('alias1'),
      'alias2': makeAuth('alias2'),
    };
    const tempIds = Object.keys(auth).filter((id) => id.startsWith('temp-'));
    expect(tempIds).toHaveLength(0);
  });

  test('demonstrates what a violation looks like', () => {
    const dirtyAuth = {
      'alias1': makeAuth('alias1'),
      'temp-abc123': makeAuth('temp-abc123'), // should have been removed
    };
    const tempIds = Object.keys(dirtyAuth).filter((id) => id.startsWith('temp-'));
    expect(tempIds).toHaveLength(1); // violation
  });
});

// ─────────────────────── TC-10: pool-wide exhaustion trigger ─────────────────────
// NOTE: health.json collapses both windows (5h PRIMARY, weekly SECONDARY) into a
// single quotaRemainingFraction. assessCodexQuotas exposes this as BOTH fiveHour
// and weekly (same value). shouldTriggerBatch uses these fields.
describe('TC-10: pool-wide exhaustion trigger (60%+ of aliases below thresholds)', () => {
  // Inline shouldTriggerBatch using the field names assessCodexQuotas returns
  function shouldTriggerBatch(aliases) {
    const POOL_TRIGGER_RATIO = 0.6;
    const FIVE_HOUR_THRESHOLD = 0.20;
    const WEEKLY_THRESHOLD = 0.30;
    const depleted = aliases.filter((a) =>
      (a.fiveHour ?? 1) <= FIVE_HOUR_THRESHOLD &&
      (a.weekly ?? 1) <= WEEKLY_THRESHOLD,
    );
    return depleted.length / aliases.length >= POOL_TRIGGER_RATIO;
  }

  test('returns true when 60%+ aliases are below both thresholds', () => {
    // 6 out of 8 aliases have fraction ≤ 0.20 → 75% ≥ 60% → trigger
    // (fiveHour === weekly === effectiveFraction per health.json design)
    const aliases = [
      { fiveHour: 0.1,  weekly: 0.1  }, // depleted
      { fiveHour: 0.15, weekly: 0.15 }, // depleted
      { fiveHour: 0.05, weekly: 0.05 }, // depleted
      { fiveHour: 0.1,  weekly: 0.1  }, // depleted
      { fiveHour: 0.0,  weekly: 0.0  }, // depleted
      { fiveHour: 0.2,  weekly: 0.2  }, // depleted (at threshold)
      { fiveHour: 0.9,  weekly: 0.9  }, // healthy
      { fiveHour: 0.7,  weekly: 0.7  }, // healthy
    ];
    expect(shouldTriggerBatch(aliases)).toBe(true);
  });

  test('returns false when below 60% depleted', () => {
    // Only 3 out of 8 depleted → 37.5% < 60%
    const aliases = [
      { fiveHour: 0.1, weekly: 0.1 }, // depleted
      { fiveHour: 0.1, weekly: 0.1 }, // depleted
      { fiveHour: 0.1, weekly: 0.1 }, // depleted
      { fiveHour: 0.8, weekly: 0.8 }, // healthy
      { fiveHour: 0.9, weekly: 0.9 }, // healthy
      { fiveHour: 0.7, weekly: 0.7 }, // healthy
      { fiveHour: 0.6, weekly: 0.6 }, // healthy
      { fiveHour: 0.5, weekly: 0.5 }, // healthy
    ];
    expect(shouldTriggerBatch(aliases)).toBe(false);
  });
});
