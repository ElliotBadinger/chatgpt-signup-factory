const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const desktopPermissionsPath = path.join(
  __dirname,
  '..',
  'app.asar.extracted',
  'dist',
  'main',
  'desktop-permissions.js'
);

function withLinuxPlatform(fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('desktop permission status reports Linux X11 as supported when nut-js backend is available', () => {
  withLinuxPlatform(() => withEnv({ DISPLAY: ':0', WAYLAND_DISPLAY: undefined }, () => {
    delete require.cache[desktopPermissionsPath];
    const { getDesktopPermissionStatus } = require(desktopPermissionsPath);
    const status = getDesktopPermissionStatus();

    assert.equal(status.platform, 'linux');
    assert.equal(status.displayServer, 'x11');
    assert.equal(status.backendAvailable, true);
    assert.equal(status.platformSupported, true);
    assert.equal(status.reason, null);
    assert.equal(status.screenRecordingGranted, false);
    assert.equal(status.accessibilityGranted, false);
  }));
});

test('assertDesktopPermissions allows supported Linux desktop backends', () => {
  withLinuxPlatform(() => withEnv({ DISPLAY: ':0', WAYLAND_DISPLAY: undefined }, () => {
    delete require.cache[desktopPermissionsPath];
    const { assertDesktopPermissions } = require(desktopPermissionsPath);

    assert.doesNotThrow(() => assertDesktopPermissions());
  }));
});

test('assertDesktopPermissions still throws the explicit Linux runtime detection reason when unsupported', () => {
  withLinuxPlatform(() => withEnv({ DISPLAY: undefined, WAYLAND_DISPLAY: 'wayland-0' }, () => {
    delete require.cache[desktopPermissionsPath];
    const { assertDesktopPermissions } = require(desktopPermissionsPath);

    assert.throws(
      () => assertDesktopPermissions(),
      /linux|wayland|backend|desktop/i
    );
  }));
});
