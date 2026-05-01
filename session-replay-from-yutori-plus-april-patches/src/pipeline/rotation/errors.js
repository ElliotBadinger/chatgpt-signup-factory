/**
 * errors.js — Typed error classes for the rotation pipeline.
 *
 * Every error carries a `context` object so the first log entry
 * tells you exactly where the process was and what state it observed.
 * All errors set `this.name` so instanceof checks and stack traces
 * remain readable without needing an import.
 */

/** @typedef {{ code: string, context?: Record<string, unknown> }} RotationErrorOptions */

export class RotationError extends Error {
  /** @param {string} message  @param {RotationErrorOptions} [opts] */
  constructor(message, opts = {}) {
    super(message);
    this.name = /** @type {string} */ (this.constructor.name);
    /** @type {string} */
    this.code = opts.code ?? this.name;
    /** @type {Record<string, unknown>} */
    this.context = opts.context ?? {};
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Thrown when the browser page is in an unexpected state during signup/login.
 * Context always includes `url` and optionally `expected`, `observed`.
 */
export class SignupStateError extends RotationError {
  /** @param {string} message  @param {Record<string, unknown>} [context] */
  constructor(message, context) {
    super(message, { code: 'SIGNUP_STATE_ERROR', context });
  }
}

/**
 * Thrown when the OTP email never arrives within the configured timeout.
 * Context: { inboxId, sinceMs, timeoutMs, url }
 */
export class OtpTimeoutError extends RotationError {
  /** @param {string} message  @param {Record<string, unknown>} [context] */
  constructor(message, context) {
    super(message, { code: 'OTP_TIMEOUT', context });
  }
}

/**
 * Thrown when the team invite flow fails (no email, no link, no accept button).
 * Context: { inboxId, phase }
 */
export class InviteError extends RotationError {
  /** @param {string} message  @param {Record<string, unknown>} [context] */
  constructor(message, context) {
    super(message, { code: 'INVITE_ERROR', context });
  }
}

/**
 * Thrown when no usable OAuth token can be extracted after login.
 * Context: { url }
 */
export class TokenExtractionError extends RotationError {
  /** @param {string} message  @param {Record<string, unknown>} [context] */
  constructor(message, context) {
    super(message, { code: 'TOKEN_EXTRACTION_ERROR', context });
  }
}

/**
 * Thrown when the inbox pool is empty and no bootstrap is available.
 */
export class PoolExhaustedError extends RotationError {
  /** @param {string} message  @param {Record<string, unknown>} [context] */
  constructor(message, context) {
    super(message, { code: 'POOL_EXHAUSTED', context });
  }
}

/**
 * Thrown when an existing ChatGPT account cannot be accessed via OTP
 * (no "use email code" option found on the password login page).
 * Caller should mark inbox as chatgpt-used and try next.
 */
export class NoEmailCodeOptionError extends RotationError {
  /** @param {string} message  @param {Record<string, unknown>} [context] */
  constructor(message, context) {
    super(message, { code: 'NO_EMAIL_CODE_OPTION', context });
  }
}

/**
 * Thrown when the Yutori Browsing API returns an HTTP error or
 * the task finishes with status='failed'.
 * Context: { taskId?, status?, statusCode?, body? }
 */
export class YutoriError extends RotationError {
  /** @param {string} message  @param {Record<string, unknown>} [context] */
  constructor(message, context) {
    super(message, { code: 'YUTORI_ERROR', context });
  }
}

/**
 * Thrown when a Yutori browsing task does not complete within the
 * configured deadline.
 * Context: { taskId, elapsedMs, timeoutMs }
 */
export class YutoriTimeoutError extends RotationError {
  /** @param {string} message  @param {Record<string, unknown>} [context] */
  constructor(message, context) {
    super(message, { code: 'YUTORI_TIMEOUT', context });
  }
}
