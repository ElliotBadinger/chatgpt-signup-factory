import { ensureBrowserLaunched } from '../chrome-devtools-mcp/build/src/browser.js';
import { puppeteer as puppeteerCore } from '../chrome-devtools-mcp/build/src/third_party/index.js';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { buildChromeArgs, getBrowserConfig } from './BrowserLaunchConfig.js';

function makeTargetFilter() {
  const ignoredPrefixes = new Set(['chrome://', 'chrome-extension://', 'chrome-untrusted://']);
  return function targetFilter(target) {
    if (target.url() === 'chrome://newtab/') return true;
    if (target.url().startsWith('chrome://inspect')) return true;
    for (const prefix of ignoredPrefixes) {
      if (target.url().startsWith(prefix)) return false;
    }
    return true;
  };
}

export class BrowserLauncher {
  static async launch({ headless, userDataDir, env = process.env }) {
    const cfg = getBrowserConfig(env);
    const restartLimit = cfg.restartLimit || 1;
    let lastError;

    for (let attempt = 1; attempt <= restartLimit; attempt++) {
      try {
        return await this._doLaunch({ headless, userDataDir, env, cfg });
      } catch (err) {
        lastError = err;
        console.error(`Browser launch attempt ${attempt}/${restartLimit} failed:`, err.message);
        if (attempt === restartLimit) break;
        // Wait a bit before retry
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw lastError;
  }

  static async _doLaunch({ headless, userDataDir, env, cfg }) {
    const chromeArgs = buildChromeArgs(env, cfg);
    const headlessMode = headless ? cfg.headlessVariant : false;

    // Remove Puppeteer's most obvious automation arg.
    const ignoreDefaultArgs = ['--enable-automation'];

    // Consistency: Set TZ env for the browser process.
    const launchEnv = { ...env, TZ: cfg.timezone };

    if (cfg.stealth) {
      const puppeteer = addExtra(puppeteerCore);
      puppeteer.use(StealthPlugin());

      return await puppeteer.launch({
        executablePath: cfg.executablePath,
        channel: cfg.executablePath ? undefined : 'chrome',
        targetFilter: makeTargetFilter(),
        defaultViewport: null,
        userDataDir,
        pipe: true,
        headless: headlessMode,
        args: [...chromeArgs, '--hide-crash-restore-bubble'],
        ignoreDefaultArgs,
        handleDevToolsAsPage: true,
        env: launchEnv,
      });
    }

    // Default (current) launcher.
    return await ensureBrowserLaunched({
      executablePath: cfg.executablePath,
      headless: headlessMode,
      channel: cfg.executablePath ? undefined : 'stable',
      userDataDir,
      chromeArgs,
      ignoreDefaultChromeArgs: ignoreDefaultArgs,
      env: launchEnv,
    });
  }
}
