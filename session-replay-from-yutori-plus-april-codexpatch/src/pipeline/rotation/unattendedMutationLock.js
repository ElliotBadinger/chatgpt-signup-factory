import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_LOCK_DIR = path.join(os.homedir(), '.pi', 'agent');
const DEFAULT_LOCK_BASENAME = 'deep-interview-fleet-mutation.lock';
const LOCK_BUSY_CODE = 'FLEET_MUTATION_LOCKED';

export class FleetMutationLockError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FleetMutationLockError';
    this.code = LOCK_BUSY_CODE;
    this.details = details;
  }
}

export function resolveFleetMutationLockPath(lockPath = process.env.PIPELINE_UNATTENDED_MUTATION_LOCK_PATH ?? null) {
  return path.resolve(lockPath || path.join(DEFAULT_LOCK_DIR, DEFAULT_LOCK_BASENAME));
}

async function readLockHolder(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function acquireFleetMutationLock({
  owner = 'unknown',
  lockPath = undefined,
  metadata = {},
} = {}) {
  const resolvedLockPath = resolveFleetMutationLockPath(lockPath);
  await fs.mkdir(path.dirname(resolvedLockPath), { recursive: true });
  const holder = {
    owner,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    cwd: process.cwd(),
    ...metadata,
  };

  let handle;
  try {
    handle = await fs.open(resolvedLockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const currentHolder = await readLockHolder(resolvedLockPath);
      const holderSummary = currentHolder == null
        ? 'unknown holder'
        : `${currentHolder.owner ?? 'unknown-owner'} pid=${currentHolder.pid ?? 'unknown'} acquiredAt=${currentHolder.acquiredAt ?? 'unknown'}`;
      throw new FleetMutationLockError(
        `Deep-interview fleet mutation lock is already held at ${resolvedLockPath} by ${holderSummary}`,
        { lockPath: resolvedLockPath, holder: currentHolder },
      );
    }
    throw error;
  }

  await handle.writeFile(`${JSON.stringify(holder, null, 2)}\n`, 'utf8');

  let released = false;
  return {
    holder,
    lockPath: resolvedLockPath,
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      await fs.rm(resolvedLockPath, { force: true });
    },
  };
}