import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FleetMutationLockError,
  acquireFleetMutationLock,
} from '../../../src/pipeline/rotation/unattendedMutationLock.js';

const heldLocks = [];

afterEach(async () => {
  while (heldLocks.length > 0) {
    const lock = heldLocks.pop();
    await lock.release();
  }
});

describe('unattended fleet mutation lock', () => {
  test('rejects a second concurrent acquisition on the shared lockfile', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mutation-lock-'));
    const lockPath = path.join(tmpDir, 'fleet.lock');

    const firstLock = await acquireFleetMutationLock({
      owner: 'test-owner-a',
      lockPath,
      metadata: { entrypoint: 'test-a' },
    });
    heldLocks.push(firstLock);

    await expect(acquireFleetMutationLock({
      owner: 'test-owner-b',
      lockPath,
      metadata: { entrypoint: 'test-b' },
    })).rejects.toMatchObject({
      code: 'FLEET_MUTATION_LOCKED',
      name: FleetMutationLockError.name,
    });

    await firstLock.release();
    heldLocks.pop();

    const secondLock = await acquireFleetMutationLock({
      owner: 'test-owner-c',
      lockPath,
      metadata: { entrypoint: 'test-c' },
    });
    heldLocks.push(secondLock);
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});