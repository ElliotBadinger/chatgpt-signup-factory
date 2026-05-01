import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

export async function launchLocalChrome(opts = {}, deps = {}) {
  const chromeBin = opts.chromeBin ?? process.env.LOCAL_CHROME_BIN ?? '/usr/bin/google-chrome';
  const launch = deps.launch ?? ((config) => {
    puppeteerExtra.use(StealthPlugin());
    return puppeteerExtra.launch(config);
  });

  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,1024',
    '--lang=en-US,en',
    '--disable-dev-shm-usage',
    '--no-sandbox',
  ];
  if (opts.proxyServer) args.push(`--proxy-server=${opts.proxyServer}`);
  if (opts.ignoreCertificateErrors) args.push('--ignore-certificate-errors');
  if (opts.userDataDir) args.push(`--user-data-dir=${opts.userDataDir}`);
  if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);

  const browser = await launch({
    executablePath: chromeBin,
    headless: opts.headless ?? false,
    args,
    env: opts.env ?? process.env,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await page.setUserAgent?.(USER_AGENT).catch?.(() => {});
  await page.setExtraHTTPHeaders?.({ 'Accept-Language': 'en-US,en' }).catch?.(() => {});
  await page.emulateTimezone?.('America/Los_Angeles').catch?.(() => {});

  return {
    browser,
    page,
    async cleanup() {
      await browser.close();
    },
  };
}
