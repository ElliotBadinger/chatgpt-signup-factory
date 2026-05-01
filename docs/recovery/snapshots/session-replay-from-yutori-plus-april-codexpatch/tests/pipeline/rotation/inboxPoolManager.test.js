import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readPool,
  writePool,
  nextAvailableInbox,
  markInboxInUse,
  markInboxFailed,
  markInboxChatGptUsed,
  addNewInboxes,
} from '../../../src/pipeline/rotation/inboxPoolManager.js';

let tmpDir, poolPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-test-'));
  poolPath = path.join(tmpDir, 'pool.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedPool(entries) {
  fs.writeFileSync(poolPath, JSON.stringify({
    version: 1,
    entries,
    lastCheckedAt: 0,
    allEntriesExhausted: false,
  }));
}

function makeEntry(overrides = {}) {
  return {
    inboxAddress: 'test@agentmail.to',
    rootEmail: 'root@example.com',
    rootOrgId: 'org_abc',
    rootApiKeyPrefix: 'am_us',
    cfRuleId: 'rule1',
    cfKvNamespaceId: 'kv1',
    status: 'available',
    statusUpdatedAt: Date.now(),
    ...overrides,
  };
}

// ────────────────────────────────── readPool ─────────────────────────────────────
describe('readPool', () => {
  test('returns empty pool when file is missing', () => {
    const pool = readPool({ poolPath });
    expect(pool.version).toBe(1);
    expect(pool.entries).toEqual([]);
    expect(pool.allEntriesExhausted).toBe(false);
  });

  test('returns existing pool from disk', () => {
    seedPool([makeEntry({ inboxAddress: 'a@agentmail.to' })]);
    const pool = readPool({ poolPath });
    expect(pool.entries).toHaveLength(1);
    expect(pool.entries[0].inboxAddress).toBe('a@agentmail.to');
  });

  test('returns empty pool on malformed JSON', () => {
    fs.writeFileSync(poolPath, 'NOT JSON');
    const pool = readPool({ poolPath });
    expect(pool.entries).toEqual([]);
  });
});

// ────────────────────────────────── writePool ────────────────────────────────────
describe('writePool', () => {
  test('writes and re-reads pool correctly', () => {
    const pool = { version: 1, entries: [makeEntry({ inboxAddress: 'b@agentmail.to' })], lastCheckedAt: 999, allEntriesExhausted: false };
    writePool(pool, { poolPath });
    const loaded = readPool({ poolPath });
    expect(loaded.entries[0].inboxAddress).toBe('b@agentmail.to');
    expect(loaded.lastCheckedAt).toBe(999);
  });
});

// ──────────────────────────────── nextAvailableInbox ─────────────────────────────
describe('nextAvailableInbox', () => {
  test('returns null when no pool file exists', () => {
    expect(nextAvailableInbox({ poolPath })).toBeNull();
  });

  test('returns null when all inboxes are used', () => {
    seedPool([makeEntry({ inboxAddress: 'a@agentmail.to', status: 'in-use' })]);
    expect(nextAvailableInbox({ poolPath })).toBeNull();
  });

  test('returns null when pool is empty', () => {
    seedPool([]);
    expect(nextAvailableInbox({ poolPath })).toBeNull();
  });

  test('returns the first available inbox', () => {
    seedPool([makeEntry({ inboxAddress: 'a@agentmail.to', status: 'available' })]);
    const entry = nextAvailableInbox({ poolPath });
    expect(entry.inboxAddress).toBe('a@agentmail.to');
  });

  test('skips non-available inboxes to find first available', () => {
    seedPool([
      makeEntry({ inboxAddress: 'used@agentmail.to', status: 'in-use' }),
      makeEntry({ inboxAddress: 'failed@agentmail.to', status: 'failed' }),
      makeEntry({ inboxAddress: 'free@agentmail.to', status: 'available' }),
    ]);
    const entry = nextAvailableInbox({ poolPath });
    expect(entry.inboxAddress).toBe('free@agentmail.to');
  });

  test('returns null when all entries are failed or chatgpt-used', () => {
    seedPool([
      makeEntry({ inboxAddress: 'a@agentmail.to', status: 'failed' }),
      makeEntry({ inboxAddress: 'b@agentmail.to', status: 'chatgpt-used' }),
    ]);
    expect(nextAvailableInbox({ poolPath })).toBeNull();
  });
});

// ──────────────────────────────── markInboxInUse ─────────────────────────────────
describe('markInboxInUse', () => {
  test('sets status to in-use and populates linkage fields', () => {
    seedPool([makeEntry({ inboxAddress: 'x@agentmail.to' })]);
    markInboxInUse('x@agentmail.to', {
      linkedAliasId: 'alias1',
      chatGptAccountId: 'uid1',
      chatGptSignupAt: 12345,
      poolPath,
    });
    const pool = readPool({ poolPath });
    const entry = pool.entries[0];
    expect(entry.status).toBe('in-use');
    expect(entry.linkedAliasId).toBe('alias1');
    expect(entry.chatGptAccountId).toBe('uid1');
    expect(entry.chatGptSignupAt).toBe(12345);
    expect(entry.statusUpdatedAt).toBeGreaterThan(0);
  });

  test('does not modify other entries', () => {
    seedPool([
      makeEntry({ inboxAddress: 'x@agentmail.to' }),
      makeEntry({ inboxAddress: 'y@agentmail.to' }),
    ]);
    markInboxInUse('x@agentmail.to', { linkedAliasId: 'a1', poolPath });
    const pool = readPool({ poolPath });
    expect(pool.entries[1].status).toBe('available');
  });

  test('no-ops on unknown address without throwing', () => {
    seedPool([makeEntry({ inboxAddress: 'x@agentmail.to' })]);
    expect(() => markInboxInUse('unknown@agentmail.to', { poolPath })).not.toThrow();
  });
});

// ──────────────────────────────── markInboxFailed ────────────────────────────────
describe('markInboxFailed', () => {
  test('sets status to failed and records reason', () => {
    seedPool([makeEntry({ inboxAddress: 'x@agentmail.to' })]);
    markInboxFailed('x@agentmail.to', 'timeout during signup', { poolPath });
    const pool = readPool({ poolPath });
    const entry = pool.entries[0];
    expect(entry.status).toBe('failed');
    expect(entry.failReason).toBe('timeout during signup');
  });
});

// ─────────────────────────────── markInboxChatGptUsed ────────────────────────────
describe('markInboxChatGptUsed', () => {
  test('sets status to chatgpt-used', () => {
    seedPool([makeEntry({ inboxAddress: 'x@agentmail.to' })]);
    markInboxChatGptUsed('x@agentmail.to', { poolPath });
    const pool = readPool({ poolPath });
    expect(pool.entries[0].status).toBe('chatgpt-used');
  });
});

// ──────────────────────────────── addNewInboxes ──────────────────────────────────
describe('addNewInboxes', () => {
  test('appends entries to an existing pool', () => {
    seedPool([makeEntry({ inboxAddress: 'a@agentmail.to' })]);
    addNewInboxes([makeEntry({ inboxAddress: 'b@agentmail.to' })], { poolPath });
    const pool = readPool({ poolPath });
    expect(pool.entries).toHaveLength(2);
    expect(pool.entries[1].inboxAddress).toBe('b@agentmail.to');
  });

  test('creates pool file if missing', () => {
    addNewInboxes([makeEntry({ inboxAddress: 'new@agentmail.to' })], { poolPath });
    const pool = readPool({ poolPath });
    expect(pool.entries).toHaveLength(1);
    expect(pool.entries[0].inboxAddress).toBe('new@agentmail.to');
  });

  test('appends multiple entries at once', () => {
    seedPool([]);
    addNewInboxes([
      makeEntry({ inboxAddress: 'a@agentmail.to' }),
      makeEntry({ inboxAddress: 'b@agentmail.to' }),
      makeEntry({ inboxAddress: 'c@agentmail.to' }),
    ], { poolPath });
    const pool = readPool({ poolPath });
    expect(pool.entries).toHaveLength(3);
  });
});

// ────────────────────── INV-5: inbox addresses are unique ────────────────────────
describe('INV-5: inbox address uniqueness', () => {
  test('entries have unique inbox addresses after successive adds', () => {
    seedPool([makeEntry({ inboxAddress: 'unique1@agentmail.to' })]);
    addNewInboxes([makeEntry({ inboxAddress: 'unique2@agentmail.to' })], { poolPath });
    const pool = readPool({ poolPath });
    const addrs = pool.entries.map((e) => e.inboxAddress);
    expect(new Set(addrs).size).toBe(addrs.length);
  });
});

// ──────────────── INV-6: in-use entries have a linkedAliasId ─────────────────────
describe('INV-6: in-use entries have linkedAliasId', () => {
  test('all in-use entries after markInboxInUse have linkedAliasId set', () => {
    seedPool([makeEntry({ inboxAddress: 'x@agentmail.to' })]);
    markInboxInUse('x@agentmail.to', { linkedAliasId: 'alias1', poolPath });
    const pool = readPool({ poolPath });
    const inUse = pool.entries.filter((e) => e.status === 'in-use');
    expect(inUse.every((e) => e.linkedAliasId != null)).toBe(true);
  });
});

// ─────────── INV-7: available entries have no linkedAliasId ──────────────────────
describe('INV-7: available entries have no linkedAliasId', () => {
  test('fresh available entries have no linkedAliasId', () => {
    seedPool([makeEntry({ inboxAddress: 'x@agentmail.to', status: 'available' })]);
    const pool = readPool({ poolPath });
    const available = pool.entries.filter((e) => e.status === 'available');
    expect(available.every((e) => e.linkedAliasId == null)).toBe(true);
  });
});
