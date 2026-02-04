import fs from 'fs';

/**
 * Runs preflight checks to ensure the environment is ready.
 * 
 * @param {Object} options
 * @param {Object} options.env Environment variables
 * @param {string} options.artifactsDir Directory for artifacts
 * @param {Object} options.fsImpl Filesystem implementation for testing
 * @returns {Object} { ok: boolean, checks: Array<{id, ok, message, fixHint}> }
 */
export function runPreflight({ env = {}, artifactsDir, fsImpl = fs } = {}) {
  const checks = [];

  // Check AgentMail API Key
  checks.push({
    id: 'env.agentmail',
    ok: !!env.AGENTMAIL_API_KEY,
    message: env.AGENTMAIL_API_KEY ? 'AgentMail API key found' : 'Missing AGENTMAIL_API_KEY in environment',
    fixHint: 'Add AGENTMAIL_API_KEY to your .env file'
  });

  // Check Artifacts Directory
  let artifactsOk = false;
  let artifactsMessage = '';
  let artifactsFixHint = '';

  if (!artifactsDir) {
    artifactsMessage = 'Artifacts directory not configured';
    artifactsFixHint = 'Check your config.json or environment';
  } else {
    try {
      // Basic check: if directory exists, is it writable?
      // If it doesn't exist, we'll assume ArtifactManager will try to create it.
      // For a thorough check we'd check parent, but let's keep it simple for now.
      if (fsImpl.existsSync && fsImpl.existsSync(artifactsDir)) {
        if (fsImpl.accessSync) {
          fsImpl.accessSync(artifactsDir, (fsImpl.constants && fsImpl.constants.W_OK) || 2);
        }
        artifactsOk = true;
        artifactsMessage = `Artifacts directory is writable: ${artifactsDir}`;
      } else {
        artifactsOk = true;
        artifactsMessage = `Artifacts directory will be created: ${artifactsDir}`;
      }
    } catch (e) {
      artifactsOk = false;
      artifactsMessage = `Artifacts directory is not writable: ${artifactsDir}`;
      artifactsFixHint = 'Ensure the directory has write permissions';
    }
  }

  checks.push({
    id: 'fs.artifacts',
    ok: artifactsOk,
    message: artifactsMessage,
    fixHint: artifactsFixHint
  });

  return { ok: checks.every(c => c.ok), checks };
}
