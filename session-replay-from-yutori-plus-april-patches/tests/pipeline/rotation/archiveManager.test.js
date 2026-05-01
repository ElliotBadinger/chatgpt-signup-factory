import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readArchive,
  writeArchive,
  archiveAlias,
  checkReinstatements,
  markReinstated,
} from '../../../src/pipeline/rotation/archiveManager.js';

let tmpDir, archivePath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  archivePath = path.join(tmpDir, 'codex-alias-archive.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const AUTH = { type: 'oauth', access: 'tok_abc', refresh: 'ref_xyz', expires: 9999999999, accountId: 'uid_111' };

// ────────────────────────────────── readArchive ──────────────────────────────────
describe('readArchive', () => {
  test('returns empty archive when file is missing', () => {
    const archive = readArchive({ archivePath });
    expect(archive.version).toBe(1);
    expect(archive.aliases).toEqual([]);
  });

  test('returns existing archive from disk', () => {
    const data = { version: 1, aliases: [{ aliasId: 'foo', reinstated: false }] };
    fs.writeFileSync(archivePath, JSON.stringify(data));
    const archive = readArchive({ archivePath });
    expect(archive.aliases).toHaveLength(1);
    expect(archive.aliases[0].aliasId).toBe('foo');
  });

  test('returns empty archive on malformed JSON', () => {
    fs.writeFileSync(archivePath, 'NOT JSON');
    const archive = readArchive({ archivePath });
    expect(archive.aliases).toEqual([]);
  });
});

// ────────────────────────────────── writeArchive ─────────────────────────────────
describe('writeArchive', () => {
  test('writes and re-reads correctly', () => {
    const archive = { version: 1, aliases: [{ aliasId: 'bar', reinstated: false }] };
    writeArchive(archive, { archivePath });
    const loaded = readArchive({ archivePath });
    expect(loaded.aliases[0].aliasId).toBe('bar');
  });
});

// ────────────────────────────────── archiveAlias ─────────────────────────────────
describe('archiveAlias', () => {
  test('appends entry to empty archive', () => {
    archiveAlias({
      aliasId: 'greenleaf',
      email: 'greenleaf@agentmail.to',
      auth: AUTH,
      reason: 'both-exhausted',
      quotaFraction: 0,
      archivePath,
    });
    const archive = readArchive({ archivePath });
    expect(archive.aliases).toHaveLength(1);
    const entry = archive.aliases[0];
    expect(entry.aliasId).toBe('greenleaf');
    expect(entry.email).toBe('greenleaf@agentmail.to');
    expect(entry.reinstated).toBe(false);
    expect(entry.archivedAt).toBeGreaterThan(0);
    expect(entry.archivedReason).toBe('both-exhausted');
    expect(entry.auth.access).toBe('tok_abc');
    expect(entry.auth.refresh).toBe('ref_xyz');
    expect(entry.cloneFrom).toBe('openai-codex');
    expect(entry.teamMemberStatus).toBe('active');
  });

  test('appends second entry without overwriting first', () => {
    archiveAlias({ aliasId: 'alias1', email: 'a@b.com', auth: AUTH, reason: 'forced', quotaFraction: 0, archivePath });
    archiveAlias({ aliasId: 'alias2', email: 'b@b.com', auth: AUTH, reason: 'forced', quotaFraction: 0, archivePath });
    const archive = readArchive({ archivePath });
    expect(archive.aliases).toHaveLength(2);
    expect(archive.aliases[0].aliasId).toBe('alias1');
    expect(archive.aliases[1].aliasId).toBe('alias2');
  });

  test('stores estimatedResetAt when provided', () => {
    const resetAt = Date.now() + 86400_000;
    archiveAlias({ aliasId: 'x', email: 'x@y.com', auth: AUTH, reason: 'weekly-exhausted', quotaFraction: 0, estimatedResetAt: resetAt, archivePath });
    const archive = readArchive({ archivePath });
    expect(archive.aliases[0].estimatedResetAt).toBe(resetAt);
  });

  test('stores quotaRemainingFraction', () => {
    archiveAlias({ aliasId: 'x', email: 'x@y.com', auth: AUTH, reason: '5h-exhausted', quotaFraction: 0.03, archivePath });
    const archive = readArchive({ archivePath });
    expect(archive.aliases[0].quotaRemainingFraction).toBe(0.03);
  });
});

// ──────────────────────────────── checkReinstatements ────────────────────────────
describe('checkReinstatements', () => {
  test('returns empty array when archive has no aliases', async () => {
    const result = await checkReinstatements(async () => 0.5, { archivePath });
    expect(result).toEqual([]);
  });

  test('returns alias when probe fraction > threshold (0.1)', async () => {
    archiveAlias({ aliasId: 'greenleaf', email: 'x@y.com', auth: AUTH, reason: 'both-exhausted', quotaFraction: 0, archivePath });
    const result = await checkReinstatements(async () => 0.5, { archivePath });
    expect(result).toHaveLength(1);
    expect(result[0].aliasId).toBe('greenleaf');
  });

  test('skips alias when probe fraction <= threshold', async () => {
    archiveAlias({ aliasId: 'greenleaf', email: 'x@y.com', auth: AUTH, reason: 'both-exhausted', quotaFraction: 0, archivePath });
    const result = await checkReinstatements(async () => 0.05, { archivePath });
    expect(result).toHaveLength(0);
  });

  test('skips alias when probe returns exactly the threshold', async () => {
    archiveAlias({ aliasId: 'greenleaf', email: 'x@y.com', auth: AUTH, reason: 'both-exhausted', quotaFraction: 0, archivePath });
    const result = await checkReinstatements(async () => 0.1, { archivePath, threshold: 0.1 });
    expect(result).toHaveLength(0); // must be GREATER than threshold
  });

  test('skips already-reinstated aliases', async () => {
    archiveAlias({ aliasId: 'greenleaf', email: 'x@y.com', auth: AUTH, reason: 'both-exhausted', quotaFraction: 0, archivePath });
    markReinstated('greenleaf', { archivePath });
    const result = await checkReinstatements(async () => 0.9, { archivePath });
    expect(result).toHaveLength(0);
  });

  test('skips alias when probe throws', async () => {
    archiveAlias({ aliasId: 'greenleaf', email: 'x@y.com', auth: AUTH, reason: 'both-exhausted', quotaFraction: 0, archivePath });
    const result = await checkReinstatements(
      async () => { throw new Error('probe failed'); },
      { archivePath },
    );
    expect(result).toHaveLength(0);
  });

  test('passes aliasId and auth to probeQuota', async () => {
    archiveAlias({ aliasId: 'myalias', email: 'x@y.com', auth: AUTH, reason: 'forced', quotaFraction: 0, archivePath });
    const receivedArgs = [];
    await checkReinstatements(async (id, auth) => {
      receivedArgs.push({ id, auth });
      return 0.5;
    }, { archivePath });
    expect(receivedArgs[0].id).toBe('myalias');
    expect(receivedArgs[0].auth.access).toBe('tok_abc');
  });

  test('returns multiple ready aliases', async () => {
    archiveAlias({ aliasId: 'a1', email: 'a@b.com', auth: AUTH, reason: 'forced', quotaFraction: 0, archivePath });
    archiveAlias({ aliasId: 'a2', email: 'b@b.com', auth: AUTH, reason: 'forced', quotaFraction: 0, archivePath });
    const result = await checkReinstatements(async () => 0.8, { archivePath });
    expect(result).toHaveLength(2);
  });
});

// ────────────────────────────────── markReinstated ───────────────────────────────
describe('markReinstated', () => {
  test('sets reinstated=true and reinstatedAt timestamp', () => {
    archiveAlias({ aliasId: 'greenleaf', email: 'x@y.com', auth: AUTH, reason: 'forced', quotaFraction: 0, archivePath });
    const before = Date.now();
    markReinstated('greenleaf', { archivePath });
    const archive = readArchive({ archivePath });
    const entry = archive.aliases[0];
    expect(entry.reinstated).toBe(true);
    expect(entry.reinstatedAt).toBeGreaterThanOrEqual(before);
  });

  test('does not modify other aliases', () => {
    archiveAlias({ aliasId: 'a1', email: 'a@b.com', auth: AUTH, reason: 'forced', quotaFraction: 0, archivePath });
    archiveAlias({ aliasId: 'a2', email: 'b@b.com', auth: AUTH, reason: 'forced', quotaFraction: 0, archivePath });
    markReinstated('a1', { archivePath });
    const archive = readArchive({ archivePath });
    expect(archive.aliases[0].reinstated).toBe(true);
    expect(archive.aliases[1].reinstated).toBe(false);
  });

  test('no-ops on unknown aliasId without throwing', () => {
    expect(() => markReinstated('nonexistent', { archivePath })).not.toThrow();
  });
});

// ────────────────────────────── INV-1: all archived have auth ────────────────────
describe('INV-1: archived aliases have full auth credentials', () => {
  test('every archiveAlias call produces entry with full auth', () => {
    archiveAlias({ aliasId: 'x', email: 'x@y.com', auth: AUTH, reason: 'forced', quotaFraction: 0, archivePath });
    const archive = readArchive({ archivePath });
    expect(archive.aliases.every((a) =>
      a.auth?.access && a.auth?.refresh && a.auth?.expires && a.auth?.accountId,
    )).toBe(true);
  });
});

// ────────────────────────────── INV-3: reinstated have reinstatedAt ──────────────
describe('INV-3: reinstated entries have reinstatedAt', () => {
  test('reinstated entries always have a reinstatedAt value', () => {
    archiveAlias({ aliasId: 'x', email: 'x@y.com', auth: AUTH, reason: 'forced', quotaFraction: 0, archivePath });
    markReinstated('x', { archivePath });
    const archive = readArchive({ archivePath });
    const reinstated = archive.aliases.filter((a) => a.reinstated);
    expect(reinstated.every((a) => a.reinstatedAt != null)).toBe(true);
  });
});
