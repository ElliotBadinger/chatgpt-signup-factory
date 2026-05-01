import { describe, expect, test } from '@jest/globals';

import {
  selectNextController,
  selectNextTarget,
} from '../../../src/pipeline/shared/selection.js';

describe('selectNextController', () => {
  const makeController = (id, status, successfulInviteCount = 0) => ({
    id,
    status,
    successfulInviteCount,
  });

  test('returns undefined when records array is empty', () => {
    expect(selectNextController([])).toBeUndefined();
  });

  test('returns undefined when no controller is in an eligible status', () => {
    const records = [
      makeController('c1', 'exhausted'),
      makeController('c2', 'failed'),
      makeController('c3', 'cooldown'),
    ];
    expect(selectNextController(records)).toBeUndefined();
  });

  test('selects a ready controller', () => {
    const records = [makeController('c1', 'ready', 0)];
    expect(selectNextController(records)).toMatchObject({ id: 'c1', status: 'ready' });
  });

  test('selects an active controller', () => {
    const records = [makeController('c1', 'active', 1)];
    expect(selectNextController(records)).toMatchObject({ id: 'c1', status: 'active' });
  });

  test('prefers the controller with the fewest successful invites (ascending order)', () => {
    const records = [
      makeController('c2', 'ready', 5),
      makeController('c1', 'ready', 2),
      makeController('c3', 'ready', 8),
    ];
    const selected = selectNextController(records);
    expect(selected?.id).toBe('c1');
  });

  test('breaks successfulInviteCount ties by id (lexicographic ascending)', () => {
    const records = [
      makeController('c-beta', 'ready', 3),
      makeController('c-alpha', 'ready', 3),
      makeController('c-gamma', 'ready', 3),
    ];
    const selected = selectNextController(records);
    expect(selected?.id).toBe('c-alpha');
  });

  test('sort is stable: does not depend on input order', () => {
    const base = [
      makeController('z1', 'ready', 0),
      makeController('a1', 'ready', 0),
    ];
    const reversed = [...base].reverse();
    expect(selectNextController(base)?.id).toBe(selectNextController(reversed)?.id);
    expect(selectNextController(base)?.id).toBe('a1');
  });

  test('respects inboxCap option: skips controllers at or over cap', () => {
    const records = [
      makeController('c1', 'ready', 10),
      makeController('c2', 'ready', 5),
      makeController('c3', 'ready', 9),
    ];
    const selected = selectNextController(records, { inboxCap: 10 });
    expect(selected?.id).toBe('c2');
  });

  test('returns undefined when all eligible controllers are at inboxCap', () => {
    const records = [
      makeController('c1', 'ready', 10),
      makeController('c2', 'ready', 10),
    ];
    expect(selectNextController(records, { inboxCap: 10 })).toBeUndefined();
  });

  test('does not mutate the input records array', () => {
    const records = [
      makeController('c2', 'ready', 5),
      makeController('c1', 'ready', 2),
    ];
    const original = records.map((r) => ({ ...r }));
    selectNextController(records);
    expect(records[0]).toEqual(original[0]);
    expect(records[1]).toEqual(original[1]);
  });
});

describe('selectNextTarget', () => {
  const makeTarget = (id, status) => ({ id, status });

  test('returns undefined when records array is empty', () => {
    expect(selectNextTarget([])).toBeUndefined();
  });

  test('returns undefined when no target has pending status', () => {
    const records = [
      makeTarget('t1', 'invited'),
      makeTarget('t2', 'accepted'),
      makeTarget('t3', 'skipped'),
    ];
    expect(selectNextTarget(records)).toBeUndefined();
  });

  test('selects a pending target', () => {
    const records = [makeTarget('t1', 'pending')];
    expect(selectNextTarget(records)).toMatchObject({ id: 't1', status: 'pending' });
  });

  test('ignores non-pending targets', () => {
    const records = [
      makeTarget('t1', 'invited'),
      makeTarget('t2', 'pending'),
      makeTarget('t3', 'accepted'),
    ];
    expect(selectNextTarget(records)).toMatchObject({ id: 't2', status: 'pending' });
  });

  test('selects the first target by id in lexicographic ascending order', () => {
    const records = [
      makeTarget('t-charlie', 'pending'),
      makeTarget('t-alpha', 'pending'),
      makeTarget('t-bravo', 'pending'),
    ];
    expect(selectNextTarget(records)?.id).toBe('t-alpha');
  });

  test('sort is stable: does not depend on input order', () => {
    const base = [makeTarget('z-last', 'pending'), makeTarget('a-first', 'pending')];
    const reversed = [...base].reverse();
    expect(selectNextTarget(base)?.id).toBe(selectNextTarget(reversed)?.id);
    expect(selectNextTarget(base)?.id).toBe('a-first');
  });

  test('does not mutate the input records array', () => {
    const records = [makeTarget('t2', 'pending'), makeTarget('t1', 'pending')];
    const original = records.map((r) => ({ ...r }));
    selectNextTarget(records);
    expect(records[0]).toEqual(original[0]);
    expect(records[1]).toEqual(original[1]);
  });
});
