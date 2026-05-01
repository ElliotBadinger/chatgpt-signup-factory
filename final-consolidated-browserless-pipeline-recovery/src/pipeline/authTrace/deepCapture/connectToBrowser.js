import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectToBrowser({ browserUrl, timeoutMs = 60000, retryMs = 1000 }) {
  puppeteerExtra.use(StealthPlugin());

  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const browser = await puppeteerExtra.connect({ browserURL: browserUrl });
      const pages = await browser.pages();
      const page = pages[0] ?? (await browser.newPage());

      return {
        browser,
        page,
        async cleanup() {
          await browser.disconnect();
        },
      };
    } catch (error) {
      lastError = error;
      await sleep(retryMs);
    }
  }

  throw lastError ?? new Error(`Timed out connecting to browser at ${browserUrl}`);
}
