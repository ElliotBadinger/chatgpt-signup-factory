import { describe, expect, jest, test } from '@jest/globals';

import { launchLocalChrome } from '../../../src/pipeline/authTrace/launchLocalChrome.js';

describe('launchLocalChrome', () => {
  test('launches puppeteer-extra with configured chrome path and returns cleanup', async () => {
    const browser = {
      pages: jest.fn(async () => [{ setUserAgent: jest.fn(async () => {}), setExtraHTTPHeaders: jest.fn(async () => {}), emulateTimezone: jest.fn(async () => {}) }]),
      close: jest.fn(async () => {}),
    };
    const launcher = jest.fn(async () => browser);

    const result = await launchLocalChrome({ chromeBin: '/usr/bin/google-chrome' }, { launch: launcher });

    expect(launcher).toHaveBeenCalledWith(expect.objectContaining({ executablePath: '/usr/bin/google-chrome' }));
    expect(result.page).toBeTruthy();
    await result.cleanup();
    expect(browser.close).toHaveBeenCalled();
  });

  test('supports proxy, temp profile, cert-ignore, env, and extra args', async () => {
    const page = { setUserAgent: jest.fn(async () => {}), setExtraHTTPHeaders: jest.fn(async () => {}), emulateTimezone: jest.fn(async () => {}) };
    const browser = {
      pages: jest.fn(async () => [page]),
      close: jest.fn(async () => {}),
    };
    const launcher = jest.fn(async () => browser);

    await launchLocalChrome({
      chromeBin: '/usr/bin/google-chrome',
      proxyServer: '127.0.0.1:8080',
      ignoreCertificateErrors: true,
      userDataDir: '/tmp/pi-auth-profile',
      extraArgs: ['--foo=bar'],
      env: { HOME: '/tmp/home-x' },
    }, { launch: launcher });

    const config = launcher.mock.calls[0][0];
    expect(config.args).toEqual(expect.arrayContaining([
      '--proxy-server=127.0.0.1:8080',
      '--ignore-certificate-errors',
      '--user-data-dir=/tmp/pi-auth-profile',
      '--foo=bar',
    ]));
    expect(config.env).toMatchObject({ HOME: '/tmp/home-x' });
  });
});
