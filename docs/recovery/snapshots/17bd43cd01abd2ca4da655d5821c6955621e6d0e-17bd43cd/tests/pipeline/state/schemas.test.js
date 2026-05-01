import { describe, expect, test } from '@jest/globals';

import {
  ControllerRecordSchema,
  ControllerSchema,
  ControllerStatus,
  InviterRecordSchema,
  InviterSchema,
  InviterStatus,
  RunEventSchema,
  TargetRecordSchema,
  TargetSchema,
  TargetStatus,
  WorkspaceObservationSchema,
} from '../../../src/pipeline/state/schemas.js';

describe('pipeline state schemas', () => {
  test('exports the planned schema names', () => {
    expect(ControllerRecordSchema).toBe(ControllerSchema);
    expect(TargetRecordSchema).toBe(TargetSchema);
    expect(InviterRecordSchema).toBe(InviterSchema);
    expect(WorkspaceObservationSchema).toBeDefined();
    expect(RunEventSchema).toBeDefined();
  });

  test('accepts valid records for each pipeline entity', () => {
    expect(
      ControllerRecordSchema.parse({
        id: 'controller-1',
        status: ControllerStatus.enum.ready,
        email: 'controller@example.com',
        successfulInviteCount: 2,
      }),
    ).toMatchObject({ id: 'controller-1', status: 'ready' });

    expect(
      TargetRecordSchema.parse({
        id: 'target-1',
        status: TargetStatus.enum.invited,
        email: 'target@example.com',
        controllerId: 'controller-1',
        invitedAt: '2026-03-12T10:00:00.000Z',
      }),
    ).toMatchObject({ id: 'target-1', status: 'invited' });

    expect(
      InviterRecordSchema.parse({
        id: 'inviter-1',
        status: InviterStatus.enum.cooldown,
        controllerId: 'controller-1',
        successfulInviteCount: 1,
      }),
    ).toMatchObject({ id: 'inviter-1', status: 'cooldown' });

    expect(
      WorkspaceObservationSchema.parse({
        workspaceId: 'workspace-1',
        observedAt: '2026-03-12T10:05:00.000Z',
        memberCount: 249,
        hardCapReached: false,
      }),
    ).toMatchObject({ workspaceId: 'workspace-1', hardCapReached: false });

    expect(
      RunEventSchema.parse({
        at: '2026-03-12T10:10:00.000Z',
        stage: 'invite',
        entity_type: 'target',
        entity_id: 'target-1',
        from_status: 'selected',
        to_status: 'invited',
        evidence: { controller_id: 'controller-1' },
      }),
    ).toMatchObject({
      stage: 'invite',
      entity_type: 'target',
      from_status: 'selected',
      to_status: 'invited',
    });
  });

  test('rejects unknown lifecycle statuses', () => {
    expect(() =>
      ControllerRecordSchema.parse({ id: 'controller-1', status: 'unknown' }),
    ).toThrow();

    expect(() =>
      TargetRecordSchema.parse({ id: 'target-1', status: 'mystery' }),
    ).toThrow();

    expect(() =>
      InviterRecordSchema.parse({ id: 'inviter-1', status: 'later' }),
    ).toThrow();
  });

  test('requires ISO timestamps where present', () => {
    expect(() =>
      TargetRecordSchema.parse({
        id: 'target-1',
        status: TargetStatus.enum.pending,
        invitedAt: 'not-a-date',
      }),
    ).toThrow();

    expect(() =>
      WorkspaceObservationSchema.parse({
        workspaceId: 'workspace-1',
        observedAt: 'yesterday',
        hardCapReached: true,
      }),
    ).toThrow();

    expect(() =>
      RunEventSchema.parse({
        at: 'soon',
        stage: 'run',
        entity_type: 'controller',
        entity_id: 'controller-1',
        from_status: 'pending',
        to_status: 'ready',
      }),
    ).toThrow();
  });

  test('RunEventSchema validates lifecycle statuses against the entity type', () => {
    expect(
      RunEventSchema.parse({
        at: '2026-03-12T10:10:00.000Z',
        stage: 'controller-dispatch',
        entity_type: 'controller',
        entity_id: 'controller-1',
        from_status: 'ready',
        to_status: 'active',
      }),
    ).toMatchObject({ entity_type: 'controller', from_status: 'ready', to_status: 'active' });

    expect(
      RunEventSchema.parse({
        at: '2026-03-12T10:10:00.000Z',
        stage: 'target-response',
        entity_type: 'target',
        entity_id: 'target-1',
        from_status: 'invited',
        to_status: 'accepted',
      }),
    ).toMatchObject({ entity_type: 'target', from_status: 'invited', to_status: 'accepted' });

    expect(() =>
      RunEventSchema.parse({
        at: '2026-03-12T10:10:00.000Z',
        stage: 'controller-dispatch',
        entity_type: 'controller',
        entity_id: 'controller-1',
        from_status: 'ready',
        to_status: 'accepted',
      }),
    ).toThrow(/status/i);

    expect(() =>
      RunEventSchema.parse({
        at: '2026-03-12T10:10:00.000Z',
        stage: 'target-selection',
        entity_type: 'target',
        entity_id: 'target-1',
        from_status: 'selected',
        to_status: 'cooldown',
      }),
    ).toThrow(/status/i);

    expect(() =>
      RunEventSchema.parse({
        at: '2026-03-12T10:10:00.000Z',
        stage: 'inviter-rotation',
        entity_type: 'inviter',
        entity_id: 'inviter-1',
        from_status: 'ready',
        to_status: 'accepted',
      }),
    ).toThrow(/status/i);
  });

  test('RunEventSchema rejects workspace as entity_type', () => {
    expect(() =>
      RunEventSchema.parse({
        at: '2026-03-12T10:10:00.000Z',
        stage: 'workspace-check',
        entity_type: 'workspace',
        entity_id: 'workspace-1',
        from_status: 'active',
        to_status: 'full',
      }),
    ).toThrow();
  });
});
