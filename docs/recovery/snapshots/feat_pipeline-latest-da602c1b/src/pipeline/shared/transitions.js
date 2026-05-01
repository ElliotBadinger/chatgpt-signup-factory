/**
 * Lifecycle transition helpers for controller and target records.
 * Pure, stateless — no I/O.
 *
 * Controller statuses (extends Task 1 schema with future success state):
 *   pending → ready | failed
 *   ready   → active | failed
 *   active  → cooldown | exhausted | failed | api_key_captured
 *   cooldown → active | exhausted | failed
 *   exhausted  (terminal)
 *   failed     (terminal)
 *   api_key_captured  (terminal success — monotonic-success guard)
 *
 * Target statuses (extends Task 1 schema with future success state):
 *   pending  → selected | skipped | failed
 *   selected → invited | skipped | failed
 *   invited  → accepted | skipped | failed | proven
 *   accepted → proven | failed
 *   skipped  (terminal)
 *   failed   (terminal)
 *   proven   (terminal success — monotonic-success guard)
 */

/** @type {Record<string, ReadonlySet<string>>} */
const CONTROLLER_TRANSITIONS = {
  pending:          new Set(['ready', 'failed']),
  ready:            new Set(['active', 'failed']),
  active:           new Set(['cooldown', 'exhausted', 'failed', 'api_key_captured']),
  cooldown:         new Set(['active', 'exhausted', 'failed']),
  exhausted:        new Set(),
  failed:           new Set(),
  api_key_captured: new Set(),
};

/** @type {Record<string, ReadonlySet<string>>} */
const TARGET_TRANSITIONS = {
  pending:  new Set(['selected', 'skipped', 'failed']),
  selected: new Set(['invited', 'skipped', 'failed']),
  invited:  new Set(['accepted', 'skipped', 'failed', 'proven']),
  accepted: new Set(['proven', 'failed']),
  skipped:  new Set(),
  failed:   new Set(),
  proven:   new Set(),
};

/**
 * Returns true if transitioning from `from` to `to` is a valid controller lifecycle step.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransitionController(from, to) {
  const allowed = CONTROLLER_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

/**
 * Returns true if transitioning from `from` to `to` is a valid target lifecycle step.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransitionTarget(from, to) {
  const allowed = TARGET_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.has(to);
}

/**
 * Asserts that the controller transition `from → to` is valid.
 * Throws a descriptive Error if not.
 *
 * @param {string} from
 * @param {string} to
 */
export function assertControllerTransition(from, to) {
  if (!canTransitionController(from, to)) {
    throw new Error(
      `Invalid controller transition: "${from}" → "${to}"`,
    );
  }
}

/**
 * Asserts that the target transition `from → to` is valid.
 * Throws a descriptive Error if not.
 *
 * @param {string} from
 * @param {string} to
 */
export function assertTargetTransition(from, to) {
  if (!canTransitionTarget(from, to)) {
    throw new Error(
      `Invalid target transition: "${from}" → "${to}"`,
    );
  }
}
