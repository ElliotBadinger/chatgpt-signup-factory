function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  const at = email.indexOf('@');
  if (at <= 0) return '[REDACTED]';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const prefix = local.slice(0, 2);
  return `${prefix}***@${domain}`;
}

function maskCardNumber(cardNumber) {
  if (!cardNumber || typeof cardNumber !== 'string') return { masked: cardNumber, last4: null };
  const digits = cardNumber.replace(/\D+/g, '');
  const last4 = digits.length >= 4 ? digits.slice(-4) : digits;
  if (!last4) return { masked: '[REDACTED]', last4: null };
  return { masked: `**** **** **** ${last4}`, last4 };
}

/**
 * Redact a validated (or partially filled) config object.
 *
 * Rules:
 * - email: keep domain, mask local part to first 2 chars + '***'
 * - password/cvc: '[REDACTED]'
 * - cardNumber: '**** **** **** <last4>' and add derived billing.cardLast4
 */
export function redactConfig(config) {
  // structuredClone is available in modern Node; fall back to JSON for safety.
  const out = globalThis.structuredClone ? structuredClone(config ?? {}) : JSON.parse(JSON.stringify(config ?? {}));

  if (out?.identity?.email) {
    out.identity.email = maskEmail(out.identity.email);
  }
  if (out?.identity?.password) {
    out.identity.password = '[REDACTED]';
  }

  if (out?.billing?.cvc) {
    out.billing.cvc = '[REDACTED]';
  }

  if (out?.billing?.cardNumber) {
    const { masked, last4 } = maskCardNumber(out.billing.cardNumber);
    out.billing.cardNumber = masked;
    if (last4) out.billing.cardLast4 = last4;
  }

  return out;
}
