export function extractJsonSchemaShape(value) {
  if (Array.isArray(value)) return { type: 'array' };
  if (value && typeof value === 'object') {
    return {
      type: 'object',
      keys: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v)])),
    };
  }
  return { type: typeof value };
}
