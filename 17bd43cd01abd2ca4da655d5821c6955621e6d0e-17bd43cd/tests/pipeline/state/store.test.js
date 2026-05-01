import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import {
  appendJsonl,
  createPipelineStore,
  loadJsonFile,
  saveJsonFile,
} from '../../../src/pipeline/state/store.js';

describe('pipeline state store', () => {
  test('loadJsonFile returns fallback and saveJsonFile persists formatted json', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-store-'));
    const filePath = path.join(stateDir, 'controller_registry.json');

    await expect(loadJsonFile(filePath, [])).resolves.toEqual([]);

    await saveJsonFile(filePath, [{ id: 'controller-1' }]);

    await expect(loadJsonFile(filePath, [])).resolves.toEqual([{ id: 'controller-1' }]);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('[\n  {\n    "id": "controller-1"\n  }\n]\n');
  });

  test('appendJsonl appends one json object per line', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-store-'));
    const filePath = path.join(stateDir, 'run_history.jsonl');

    await appendJsonl(filePath, { step: 1 });
    await appendJsonl(filePath, { step: 2, ok: true });

    await expect(readFile(filePath, 'utf8')).resolves.toBe(
      '{"step":1}\n{"step":2,"ok":true}\n',
    );
  });

  test('upsert methods merge partial updates by stable id without dropping prior successful fields and use planned registry filenames', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-store-'));
    const store = createPipelineStore({ stateDir });

    await store.upsertController({
      id: 'controller-1',
      status: 'ready',
      email: 'controller@example.com',
      successfulInviteCount: 3,
      lastSuccessfulTargetId: 'target-3',
    });
    await store.upsertController({ id: 'controller-1', status: 'active' });

    await store.upsertTarget({
      id: 'target-1',
      status: 'invited',
      email: 'target@example.com',
      controllerId: 'controller-1',
      invitedAt: '2026-03-12T10:00:00.000Z',
    });
    await store.upsertTarget({ id: 'target-1', status: 'accepted' });

    await store.upsertInviter({
      id: 'inviter-1',
      status: 'ready',
      controllerId: 'controller-1',
      successfulInviteCount: 1,
    });
    await store.upsertInviter({ id: 'inviter-1', status: 'cooldown' });

    await store.upsertWorkspaceObservation({
      workspaceId: 'workspace-1',
      observedAt: '2026-03-12T10:05:00.000Z',
      memberCount: 249,
      hardCapReached: false,
    });
    await store.upsertWorkspaceObservation({
      workspaceId: 'workspace-1',
      hardCapReached: true,
    });

    await expect(store.listControllers()).resolves.toEqual([
      {
        id: 'controller-1',
        status: 'active',
        email: 'controller@example.com',
        successfulInviteCount: 3,
        lastSuccessfulTargetId: 'target-3',
      },
    ]);

    await expect(store.listTargets()).resolves.toEqual([
      {
        id: 'target-1',
        status: 'accepted',
        email: 'target@example.com',
        controllerId: 'controller-1',
        invitedAt: '2026-03-12T10:00:00.000Z',
      },
    ]);

    await expect(store.listInviters()).resolves.toEqual([
      {
        id: 'inviter-1',
        status: 'cooldown',
        controllerId: 'controller-1',
        successfulInviteCount: 1,
      },
    ]);

    await expect(store.listWorkspaceObservations()).resolves.toEqual([
      {
        workspaceId: 'workspace-1',
        observedAt: '2026-03-12T10:05:00.000Z',
        memberCount: 249,
        hardCapReached: true,
      },
    ]);

    await expect(readFile(path.join(stateDir, 'controller_registry.json'), 'utf8')).resolves.toContain(
      'controller-1',
    );
    await expect(readFile(path.join(stateDir, 'target_registry.json'), 'utf8')).resolves.toContain(
      'target-1',
    );
    await expect(readFile(path.join(stateDir, 'inviter_registry.json'), 'utf8')).resolves.toContain(
      'inviter-1',
    );
    await expect(readFile(path.join(stateDir, 'workspace_observations.json'), 'utf8')).resolves.toContain(
      'workspace-1',
    );
  });

  test('serializes overlapping upserts for the same registry file so updates are not lost', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-store-'));
    const store = createPipelineStore({ stateDir });

    await store.upsertController({
      id: 'controller-1',
      status: 'ready',
      email: 'controller@example.com',
    });

    await Promise.all([
      store.upsertController({
        id: 'controller-1',
        status: 'active',
      }),
      store.upsertController({
        id: 'controller-1',
        successfulInviteCount: 4,
      }),
    ]);

    await expect(store.listControllers()).resolves.toEqual([
      {
        id: 'controller-1',
        status: 'active',
        email: 'controller@example.com',
        successfulInviteCount: 4,
      },
    ]);
  });

  test('appendRunEvent validates and appends planned run history records', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-store-'));
    const store = createPipelineStore({ stateDir });

    await store.appendRunEvent({
      at: '2026-03-12T10:15:00.000Z',
      stage: 'invite',
      entity_type: 'controller',
      entity_id: 'controller-1',
      from_status: 'ready',
      to_status: 'active',
      metadata: { target_id: 'target-1' },
    });

    const history = await readFile(path.join(stateDir, 'run_history.jsonl'), 'utf8');
    expect(history).toBe(
      '{"at":"2026-03-12T10:15:00.000Z","stage":"invite","entity_type":"controller","entity_id":"controller-1","from_status":"ready","to_status":"active","metadata":{"target_id":"target-1"}}\n',
    );
  });
});
