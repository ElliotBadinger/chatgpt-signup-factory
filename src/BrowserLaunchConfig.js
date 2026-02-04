// NOTE: Keep this consistent with the actual Chrome channel installed on the host.
// (We run on Linux with the system Google Chrome stable channel.)
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

export function getBrowserConfig(env = process.env) {
  return {
    // Feature toggles
    stealth: String(env.STEALTH || '').toLowerCase() === 'true',
    headlessVariant: env.BROWSER_HEADLESS_VARIANT || 'new',
    executablePath: env.CHROME_EXECUTABLE_PATH || undefined,

    // Fingerprint consistency knobs
    userAgent: env.BROWSER_UA || DEFAULT_USER_AGENT,
    // Used both for chrome --lang and Accept-Language.
    lang: env.BROWSER_LANG || 'en-US,en',
    timezone: env.BROWSER_TIMEZONE || 'America/Los_Angeles',
    windowSize: env.BROWSER_WINDOW_SIZE || '1280,1024',

    // Bounded restart knobs
    restartLimit: Number(env.BROWSER_RESTART_LIMIT) || 2,

    // Raw passthrough for experimentation
    chromeArgsExtra: env.CHROME_ARGS_EXTRA || '',
  };
}

export function buildChromeArgs(env = process.env, cfg = getBrowserConfig(env)) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',

    // Reduce common automation signals.
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-position=0,0',

    // OSS Stealth improvements
    '--disable-features=IsolateOrigins,site-per-process',
    '--font-render-hinting=none',

    // Fingerprint consistency.
    `--user-agent=${cfg.userAgent}`,
    `--lang=${cfg.lang}`,
    `--window-size=${cfg.windowSize}`,
  ];

  // Allow ad-hoc experimentation without code changes.
  if (cfg.chromeArgsExtra && typeof cfg.chromeArgsExtra === 'string') {
    const extra = cfg.chromeArgsExtra
      .split(/\s+/)
      .map(s => s.trim())
      .filter(Boolean);
    args.push(...extra);
  }

  // De-dupe while preserving order.
  const seen = new Set();
  const out = [];
  for (const a of args) {
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

export { DEFAULT_USER_AGENT };
