/**
 * inboxPoolManager.js
 *
 * Manages ~/.pi/agent/codex-inbox-pool.json:
 *   - Read/write the inbox pool atomically
 *   - Find the next available inbox
 *   - Mark inboxes as in-use / failed / chatgpt-used
 *   - Append new inboxes provisioned from a new root mailbox
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_POOL_PATH = path.join(os.homedir(), '.pi', 'agent', 'codex-inbox-pool.json');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function atomicWrite(filePath, data) {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
}

const EMPTY_POOL = () => ({ version: 1, entries: [], lastCheckedAt: 0, allEntriesExhausted: false });

/**
 * Read the inbox pool from disk.
 * Returns an empty pool if file is missing or malformed.
 */
export function readPool({ poolPath = DEFAULT_POOL_PATH } = {}) {
  try {
    if (!fs.existsSync(poolPath)) return EMPTY_POOL();
    const raw = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return EMPTY_POOL();
    return raw;
  } catch {
    return EMPTY_POOL();
  }
}

/**
 * Atomically write the pool to disk.
 */
export function writePool(pool, { poolPath = DEFAULT_POOL_PATH } = {}) {
  atomicWrite(poolPath, pool);
}

/**
 * Return the first inbox with status="available", or null if none exist.
 */
export function nextAvailableInbox({ poolPath = DEFAULT_POOL_PATH } = {}) {
  const pool = readPool({ poolPath });
  return pool.entries.find((e) => e.status === 'available') ?? null;
}

/**
 * Internal helper — apply an updater function to the entry matching inboxAddress.
 * No-ops if the address is not found.
 */
function updateEntry(inboxAddress, updater, { poolPath = DEFAULT_POOL_PATH } = {}) {
  const pool = readPool({ poolPath });
  const entry = pool.entries.find((e) => e.inboxAddress === inboxAddress);
  if (!entry) return;
  updater(entry);
  entry.statusUpdatedAt = Date.now();
  writePool(pool, { poolPath });
}

/**
 * Mark an inbox as in-use and record the linked ChatGPT account.
 *
 * @param {string} inboxAddress
 * @param {object} opts
 * @param {string} [opts.linkedAliasId]
 * @param {string} [opts.chatGptAccountId]
 * @param {number} [opts.chatGptSignupAt]
 * @param {string} [opts.poolPath]
 */
export function markInboxInUse(inboxAddress, {
  linkedAliasId,
  chatGptAccountId,
  chatGptSignupAt,
  poolPath = DEFAULT_POOL_PATH,
} = {}) {
  updateEntry(inboxAddress, (e) => {
    e.status = 'in-use';
    if (linkedAliasId !== undefined) e.linkedAliasId = linkedAliasId;
    if (chatGptAccountId !== undefined) e.chatGptAccountId = chatGptAccountId;
    if (chatGptSignupAt !== undefined) e.chatGptSignupAt = chatGptSignupAt;
  }, { poolPath });
}

/**
 * Mark an inbox as failed (e.g. OTP timeout, probe failure).
 *
 * @param {string} inboxAddress
 * @param {string} reason
 * @param {object} [opts]
 */
export function markInboxFailed(inboxAddress, reason, { poolPath = DEFAULT_POOL_PATH } = {}) {
  updateEntry(inboxAddress, (e) => {
    e.status = 'failed';
    e.failReason = reason;
  }, { poolPath });
}

/**
 * Mark an inbox as chatgpt-used (email address was already registered with ChatGPT).
 * This inbox cannot be used for a fresh account.
 *
 * @param {string} inboxAddress
 * @param {object} [opts]
 */
export function markInboxChatGptUsed(inboxAddress, { poolPath = DEFAULT_POOL_PATH } = {}) {
  updateEntry(inboxAddress, (e) => {
    e.status = 'chatgpt-used';
  }, { poolPath });
}

/**
 * Append new inbox entries to the pool (called after Stage 1 bootstrap provisioning).
 *
 * @param {object[]} entries  - Array of InboxPoolEntry objects to append
 * @param {object}   [opts]
 */
export function addNewInboxes(entries, { poolPath = DEFAULT_POOL_PATH } = {}) {
  const pool = readPool({ poolPath });
  pool.entries.push(...entries);
  writePool(pool, { poolPath });
}
