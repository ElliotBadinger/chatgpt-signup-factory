// Backwards-compatible module surface.
// Prefer importing from ./manager.js and ./redaction.js directly.

export { loadConfig, saveConfig, validateConfig } from './manager.js';
export { redactConfig } from './redaction.js';
export { AppConfigSchema } from './schema.js';
