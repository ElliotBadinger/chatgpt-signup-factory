import { describe, expect, test } from '@jest/globals';

import {
  assertControllerTransition,
  assertTargetTransition,
  canTransitionController,
  canTransitionTarget,
} from '../../../src/pipeline/shared/transitions.js';

describe('canTransitionController', () => {
  test('allows valid forward transitions from each status', () => {
    expect(canTransitionController('pending', 'ready')).toBe(true);
    expect(canTransitionController('pending', 'failed')).toBe(true);
    expect(canTransitionController('ready', 'active')).toBe(true);
    expect(canTransitionController('ready', 'failed')).toBe(true);
    expect(canTransitionController('active', 'cooldown')).toBe(true);
    expect(canTransitionController('active', 'exhausted')).toBe(true);
    expect(canTransitionController('active', 'failed')).toBe(true);
    expect(canTransitionController('active', 'api_key_captured')).toBe(true);
    expect(canTransitionController('cooldown', 'active')).toBe(true);
    expect(canTransitionController('cooldown', 'exhausted')).toBe(true);
    expect(canTransitionController('cooldown', 'failed')).toBe(true);
  });

  test('rejects transitions from terminal statuses', () => {
    expect(canTransitionController('exhausted', 'active')).toBe(false);
    expect(canTransitionController('exhausted', 'pending')).toBe(false);
    expect(canTransitionController('failed', 'ready')).toBe(false);
    expect(canTransitionController('failed', 'active')).toBe(false);
    expect(canTransitionController('api_key_captured', 'active')).toBe(false);
    expect(canTransitionController('api_key_captured', 'cooldown')).toBe(false);
  });

  test('rejects nonsensical same-status and backward transitions', () => {
    expect(canTransitionController('ready', 'pending')).toBe(false);
    expect(canTransitionController('active', 'pending')).toBe(false);
    expect(canTransitionController('active', 'ready')).toBe(false);
    expect(canTransitionController('cooldown', 'pending')).toBe(false);
  });

  test('rejects unknown statuses', () => {
    expect(canTransitionController('unknown', 'ready')).toBe(false);
    expect(canTransitionController('ready', 'unknown')).toBe(false);
    expect(canTransitionController('invalid', 'invalid')).toBe(false);
  });
});

describe('canTransitionTarget', () => {
  test('allows valid forward transitions from each status', () => {
    expect(canTransitionTarget('pending', 'selected')).toBe(true);
    expect(canTransitionTarget('pending', 'skipped')).toBe(true);
    expect(canTransitionTarget('pending', 'failed')).toBe(true);
    expect(canTransitionTarget('selected', 'invited')).toBe(true);
    expect(canTransitionTarget('selected', 'skipped')).toBe(true);
    expect(canTransitionTarget('selected', 'failed')).toBe(true);
    expect(canTransitionTarget('invited', 'accepted')).toBe(true);
    expect(canTransitionTarget('invited', 'skipped')).toBe(true);
    expect(canTransitionTarget('invited', 'failed')).toBe(true);
    expect(canTransitionTarget('invited', 'proven')).toBe(true);
    expect(canTransitionTarget('accepted', 'proven')).toBe(true);
    expect(canTransitionTarget('accepted', 'failed')).toBe(true);
  });

  test('rejects transitions from terminal statuses', () => {
    expect(canTransitionTarget('skipped', 'pending')).toBe(false);
    expect(canTransitionTarget('skipped', 'selected')).toBe(false);
    expect(canTransitionTarget('failed', 'pending')).toBe(false);
    expect(canTransitionTarget('failed', 'selected')).toBe(false);
    expect(canTransitionTarget('proven', 'accepted')).toBe(false);
    expect(canTransitionTarget('proven', 'invited')).toBe(false);
  });

  test('rejects backward transitions (monotonic-success guard)', () => {
    expect(canTransitionTarget('selected', 'pending')).toBe(false);
    expect(canTransitionTarget('invited', 'pending')).toBe(false);
    expect(canTransitionTarget('invited', 'selected')).toBe(false);
    expect(canTransitionTarget('accepted', 'pending')).toBe(false);
    expect(canTransitionTarget('accepted', 'selected')).toBe(false);
    expect(canTransitionTarget('accepted', 'invited')).toBe(false);
  });

  test('rejects unknown statuses', () => {
    expect(canTransitionTarget('unknown', 'selected')).toBe(false);
    expect(canTransitionTarget('pending', 'unknown')).toBe(false);
  });
});

describe('assertControllerTransition', () => {
  test('does not throw for valid transitions', () => {
    expect(() => assertControllerTransition('pending', 'ready')).not.toThrow();
    expect(() => assertControllerTransition('active', 'api_key_captured')).not.toThrow();
    expect(() => assertControllerTransition('cooldown', 'active')).not.toThrow();
  });

  test('throws for invalid transitions', () => {
    expect(() => assertControllerTransition('exhausted', 'active')).toThrow();
    expect(() => assertControllerTransition('api_key_captured', 'cooldown')).toThrow();
    expect(() => assertControllerTransition('active', 'pending')).toThrow();
  });

  test('thrown error identifies the invalid transition', () => {
    expect(() => assertControllerTransition('failed', 'ready')).toThrow(/failed.*ready|ready.*failed/i);
  });
});

describe('assertTargetTransition', () => {
  test('does not throw for valid transitions', () => {
    expect(() => assertTargetTransition('pending', 'selected')).not.toThrow();
    expect(() => assertTargetTransition('accepted', 'proven')).not.toThrow();
    expect(() => assertTargetTransition('invited', 'proven')).not.toThrow();
  });

  test('throws for invalid transitions', () => {
    expect(() => assertTargetTransition('proven', 'accepted')).toThrow();
    expect(() => assertTargetTransition('skipped', 'pending')).toThrow();
    expect(() => assertTargetTransition('invited', 'pending')).toThrow();
  });

  test('thrown error identifies the invalid transition', () => {
    expect(() => assertTargetTransition('proven', 'pending')).toThrow(/proven.*pending|pending.*proven/i);
  });
});
