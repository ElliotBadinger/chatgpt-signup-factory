import path from 'node:path';

const REQUIRED_CHROME_ARGS = ['--no-first-run', '--no-default-browser-check'];

function normalizeString(value, fieldName) {
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }

  return normalizedValue;
}

export function buildProfilePath({ profilesRoot, entityType, entityId }) {
  const normalizedProfilesRoot = normalizeString(profilesRoot, 'profilesRoot');
  const normalizedEntityId = normalizeString(entityId, 'entityId');

  if (entityType == null) {
    return path.join(normalizedProfilesRoot, normalizedEntityId);
  }

  return path.join(
    normalizedProfilesRoot,
    normalizeString(entityType, 'entityType'),
    normalizedEntityId,
  );
}

export function buildLaunchConfig({
  profilesRoot,
  entityType,
  entityId,
  executablePath,
  args = [],
  xvfbDisplay = ':99',
}) {
  const normalizedArgs = Array.isArray(args) ? args : [];

  return {
    mode: 'launch',
    browser: 'chrome',
    headless: false,
    executablePath: normalizeString(executablePath, 'executablePath'),
    userDataDir: buildProfilePath({ profilesRoot, entityType, entityId }),
    xvfb: {
      enabled: true,
      display: normalizeString(xvfbDisplay, 'xvfbDisplay'),
    },
    args: [...REQUIRED_CHROME_ARGS, ...normalizedArgs],
  };
}

export function buildAttachConfig({ cdpEndpoint }) {
  const normalizedEndpoint = cdpEndpoint instanceof URL
    ? cdpEndpoint.toString()
    : normalizeString(cdpEndpoint, 'cdpEndpoint');

  return {
    mode: 'attach',
    browser: 'chrome',
    cdpEndpoint: normalizedEndpoint,
  };
}

export function resolveSessionMode(config) {
  const hasLaunch = Boolean(config?.launch);
  const hasAttach = Boolean(config?.attach);

  if (hasLaunch && hasAttach) {
    throw new Error('Browser session config is ambiguous: choose launch or attach, not both.');
  }

  if (hasLaunch) {
    return 'launch';
  }

  if (hasAttach) {
    return 'attach';
  }

  throw new Error('Browser session config must choose either launch or attach.');
}
