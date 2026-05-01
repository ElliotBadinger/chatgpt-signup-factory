const SENSITIVE_HEADER_NAMES = new Set(['authorization', 'cookie', 'set-cookie', 'x-openai-client-secret']);

export function redactValue(value) {
  if (value == null) return value;
  const text = String(value);
  if (/^Bearer\s+/i.test(text)) return '[REDACTED]';
  if (/^(eyJ|sk-|rt_|sess_|__session)/.test(text)) return '[REDACTED]';
  return text;
}

export function redactHeaders(headers = {}) {
  const entries = Object.entries(headers).map(([key, value]) => {
    const out = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? '[REDACTED]' : redactValue(value);
    return [key, out];
  });
  return Object.fromEntries(entries);
}

export function redactObjectShallow(obj = {}) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = redactHeaders(value);
    } else {
      out[key] = redactValue(value);
    }
  }
  return out;
}
