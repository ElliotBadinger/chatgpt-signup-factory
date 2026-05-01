/**
 * archiveManager.js
 *
 * Manages ~/.pi/agent/codex-alias-archive.json:
 *   - Read/write the archive atomically
 *   - Archive an exhausted alias (append entry)
 *   - Check for reinstatements (probe live quota)
 *   - Mark an archived alias as reinstated
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ARCHIVE_PATH = path.join(os.homedir(), '.pi', 'agent', 'codex-alias-archive.json');
const REINSTATEMENT_THRESHOLD = 0.1;

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

/**
 * Read the archive file from disk.
 * Returns { version: 1, aliases: [] } if missing or malformed.
 */
export function readArchive({ archivePath = DEFAULT_ARCHIVE_PATH } = {}) {
  try {
    if (!fs.existsSync(archivePath)) return { version: 1, aliases: [] };
    const raw = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.aliases)) {
      return { version: 1, aliases: [] };
    }
    return raw;
  } catch {
    return { version: 1, aliases: [] };
  }
}

/**
 * Atomically write the archive to disk.
 */
export function writeArchive(archive, { archivePath = DEFAULT_ARCHIVE_PATH } = {}) {
  atomicWrite(archivePath, archive);
}

/**
 * Append an archived alias entry to the archive file.
 *
 * @param {object} opts
 * @param {string} opts.aliasId       - e.g. "horriblesupport64"
 * @param {string} opts.email         - e.g. "horriblesupport64@agentmail.to"
 * @param {object} opts.auth          - Full OAuth credentials
 * @param {string} opts.reason        - "weekly-exhausted" | "5h-exhausted" | "both-exhausted" | "forced"
 * @param {number} [opts.estimatedResetAt] - ms epoch of expected quota reset
 * @param {number} [opts.quotaFraction]    - quota fraction at archival time
 * @param {string} [opts.archivePath]
 * @returns {object} The newly created archive entry
 */
export function archiveAlias({
  aliasId,
  email,
  auth,
  reason,
  estimatedResetAt,
  quotaFraction = 0,
  archivePath = DEFAULT_ARCHIVE_PATH,
}) {
  const archive = readArchive({ archivePath });

  const entry = {
    aliasId,
    email,
    cloneFrom: 'openai-codex',
    auth,
    archivedAt: Date.now(),
    archivedReason: reason,
    quotaRemainingFraction: quotaFraction,
    quotaWindow: 'unknown',
    ...(estimatedResetAt != null ? { estimatedResetAt } : {}),
    reinstated: false,
    teamMemberStatus: 'active',
  };

  archive.aliases.push(entry);
  writeArchive(archive, { archivePath });
  return entry;
}

/**
 * Check which archived aliases have had their quota renewed.
 *
 * Calls probeQuota(aliasId, auth) for each non-reinstated alias.
 * If the returned fraction is strictly greater than `threshold` (default 0.1),
 * the alias is included in the returned list.
 *
 * Errors from probeQuota are silently swallowed (the alias is skipped).
 *
 * @param {Function} probeQuota - async (aliasId: string, auth: object) => number
 * @param {object}   opts
 * @param {string}   [opts.archivePath]
 * @param {number}   [opts.threshold=0.1]
 * @returns {Promise<ArchivedAlias[]>} Aliases ready for reinstatement
 */
export async function checkReinstatements(probeQuota, {
  archivePath = DEFAULT_ARCHIVE_PATH,
  threshold = REINSTATEMENT_THRESHOLD,
} = {}) {
  const archive = readArchive({ archivePath });
  const candidates = archive.aliases.filter((a) => !a.reinstated);
  const ready = [];

  for (const alias of candidates) {
    try {
      const fraction = await probeQuota(alias.aliasId, alias.auth);
      if (fraction > threshold) {
        ready.push(alias);
      }
    } catch {
      // Skip on probe error — don't reinstate if we can't verify
    }
  }

  return ready;
}

/**
 * Mark an archived alias as reinstated.
 * Sets reinstated=true and reinstatedAt=Date.now().
 * No-ops if the aliasId is not found.
 *
 * @param {string} aliasId
 * @param {object} [opts]
 * @param {string} [opts.archivePath]
 */
export function markReinstated(aliasId, { archivePath = DEFAULT_ARCHIVE_PATH } = {}) {
  const archive = readArchive({ archivePath });
  const entry = archive.aliases.find((a) => a.aliasId === aliasId);
  if (!entry) return;

  entry.reinstated = true;
  entry.reinstatedAt = Date.now();
  writeArchive(archive, { archivePath });
}
