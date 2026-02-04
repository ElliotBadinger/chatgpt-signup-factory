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
 * - Recursive: any key named password/cvc/cardNumber found anywhere is redacted/masked.
 */
export function redactConfig(config) {
  // structuredClone is available in modern Node; fall back to JSON for safety.
  const out = globalThis.structuredClone ? structuredClone(config ?? {}) : JSON.parse(JSON.stringify(config ?? {}));

  if (out === null || typeof out !== 'object') return out;

  const redactRecursive = (obj) => {
    if (obj === null || typeof obj !== 'object') return;

    for (const key in obj) {
      if (key === 'email' && typeof obj[key] === 'string') {
        obj[key] = maskEmail(obj[key]);
      } else if (key === 'password' || key === 'cvc') {
        obj[key] = '[REDACTED]';
      } else if (key === 'cardNumber' && typeof obj[key] === 'string') {
        const { masked, last4 } = maskCardNumber(obj[key]);
        obj[key] = masked;
        if (last4) obj.cardLast4 = last4;
      } else {
        redactRecursive(obj[key]);
      }
    }
  };

  redactRecursive(out);
  return out;
}
