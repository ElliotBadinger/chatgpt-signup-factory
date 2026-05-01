import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import {
  buildAttachConfig,
  buildLaunchConfig,
  buildProfilePath,
  resolveSessionMode,
} from '../../../src/pipeline/browser/sessionManager.js';

describe('buildProfilePath', () => {
  test('builds a deterministic profile path from the entity id', () => {
    expect(
      buildProfilePath({
        profilesRoot: '/tmp/browser-profiles',
        entityId: 'controller-42',
      }),
    ).toBe(path.join('/tmp/browser-profiles', 'controller-42'));
  });

  test('namespaces the deterministic profile path by entity type when provided', () => {
    expect(
      buildProfilePath({
        profilesRoot: '/tmp/browser-profiles',
        entityType: 'controller',
        entityId: 'controller-42',
      }),
    ).toBe(path.join('/tmp/browser-profiles', 'controller', 'controller-42'));
  });
});

describe('buildLaunchConfig', () => {
  test('normalizes launch config for xvfb-backed real chrome', () => {
    expect(
      buildLaunchConfig({
        profilesRoot: '/tmp/browser-profiles',
        entityType: 'controller',
        entityId: 'controller-42',
        executablePath: '/usr/bin/google-chrome',
      }),
    ).toEqual({
      mode: 'launch',
      browser: 'chrome',
      headless: false,
      executablePath: '/usr/bin/google-chrome',
      userDataDir: path.join('/tmp/browser-profiles', 'controller', 'controller-42'),
      xvfb: {
        enabled: true,
        display: ':99',
      },
      args: ['--no-first-run', '--no-default-browser-check'],
    });
  });

  test('preserves caller args after the required chrome defaults', () => {
    expect(
      buildLaunchConfig({
        profilesRoot: '/tmp/browser-profiles',
        entityId: 'inviter-7',
        executablePath: '/usr/bin/google-chrome-stable',
        args: ['--disable-gpu', '--window-size=1280,720'],
        xvfbDisplay: ':41',
      }),
    ).toEqual({
      mode: 'launch',
      browser: 'chrome',
      headless: false,
      executablePath: '/usr/bin/google-chrome-stable',
      userDataDir: path.join('/tmp/browser-profiles', 'inviter-7'),
      xvfb: {
        enabled: true,
        display: ':41',
      },
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
      ],
    });
  });
});

describe('buildAttachConfig', () => {
  test('normalizes attach config from a cdp endpoint string', () => {
    expect(
      buildAttachConfig({
        cdpEndpoint: ' ws://127.0.0.1:9222/devtools/browser/example-id ',
      }),
    ).toEqual({
      mode: 'attach',
      browser: 'chrome',
      cdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/example-id',
    });
  });

  test('accepts a URL instance and serializes it to a cdp endpoint string', () => {
    expect(
      buildAttachConfig({
        cdpEndpoint: new URL('http://127.0.0.1:9222'),
      }),
    ).toEqual({
      mode: 'attach',
      browser: 'chrome',
      cdpEndpoint: 'http://127.0.0.1:9222/',
    });
  });
});

describe('resolveSessionMode', () => {
  test('returns launch when launch config is present', () => {
    expect(resolveSessionMode({ launch: { executablePath: '/usr/bin/google-chrome' } })).toBe('launch');
  });

  test('returns attach when attach config is present', () => {
    expect(resolveSessionMode({ attach: { cdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/id' } })).toBe('attach');
  });

  test('rejects ambiguous config that tries to launch and attach at once', () => {
    expect(() =>
      resolveSessionMode({
        launch: { executablePath: '/usr/bin/google-chrome' },
        attach: { cdpEndpoint: 'ws://127.0.0.1:9222/devtools/browser/id' },
      }),
    ).toThrow('Browser session config is ambiguous: choose launch or attach, not both.');
  });

  test('rejects config that provides neither launch nor attach', () => {
    expect(() => resolveSessionMode({})).toThrow(
      'Browser session config must choose either launch or attach.',
    );
  });
});
