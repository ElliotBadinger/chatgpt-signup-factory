# Cloudflare/Turnstile Headless Reliability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make headless cold-start runs reliably pass Cloudflare/Turnstile and complete the full business trial flow (through Subscribe-click progress verification) for 3 consecutive runs.

**Architecture:** Keep Chrome DevTools MCP snapshot-driven automation, but harden the browser fingerprint using optional puppeteer-extra stealth + stronger launch flags + consistent locale/timezone. Improve BLOCKED state handling with bounded wait/click strategy and bounded browser restarts, while avoiding screenshot spam.

**Tech Stack:** Node.js (ESM), Jest, chrome-devtools-mcp (Puppeteer), puppeteer-extra + stealth plugin.

---

### Task 1: Add env-driven browser launch configuration helpers

**Files:**
- Create: `src/BrowserLaunchConfig.js`
- Test: `tests/BrowserLaunchConfig.test.js`

**Step 1: Write failing tests (RED)**

```js
import { buildChromeArgs, getBrowserConfig } from '../src/BrowserLaunchConfig.js';

test('buildChromeArgs includes default hardening flags', () => {
  const args = buildChromeArgs({});
  expect(args).toContain('--disable-blink-features=AutomationControlled');
  expect(args).toContain('--lang=en-US,en');
});

test('buildChromeArgs appends CHROME_ARGS_EXTRA', () => {
  const args = buildChromeArgs({ CHROME_ARGS_EXTRA: '--foo=bar --baz' });
  expect(args).toContain('--foo=bar');
  expect(args).toContain('--baz');
});

test('getBrowserConfig parses STEALTH and TIMEZONE defaults', () => {
  const cfg = getBrowserConfig({ STEALTH: 'true' });
  expect(cfg.stealth).toBe(true);
  expect(cfg.timezone).toBeTruthy();
});
```

**Step 2: Run tests to verify failure**

Run: `npm test tests/BrowserLaunchConfig.test.js`
Expected: FAIL (module missing).

**Step 3: Implement minimal helpers (GREEN)**
- Implement `getBrowserConfig(env)` returning `{ stealth, headless, timezone, locale, userAgent, extraArgs }`.
- Implement `buildChromeArgs(env, cfg)` producing a deterministic args list.

**Step 4: Run tests to verify pass**
Run: `npm test tests/BrowserLaunchConfig.test.js`
Expected: PASS.

---

### Task 2: Integrate puppeteer-extra stealth (gated by STEALTH=true)

**Files:**
- Modify: `package.json` (+ install deps)
- Create: `src/BrowserLauncher.js`
- Modify: `src/SignupFactory.js`

**Step 1: Add dependencies**
- Add `puppeteer-extra` and `puppeteer-extra-plugin-stealth`.

**Step 2: Implement `BrowserLauncher.launch()`**
- Default path: call existing `ensureBrowserLaunched`.
- Stealth path: create a puppeteer-extra instance wrapping the same puppeteer-core used by chrome-devtools-mcp and `launch()` with:
  - `ignoreDefaultArgs: ['--enable-automation']`
  - `headless: 'new'` when headless requested
  - hardened args from `buildChromeArgs()`

**Step 3: Ensure patches apply to all pages**
- In `SignupFactory.init()`, after launch:
  - apply `page.setUserAgent`, `page.setExtraHTTPHeaders({ 'Accept-Language': ... })`, `page.emulateTimezone(...)`
  - `evaluateOnNewDocument` patch (webdriver/languages/plugins)
  - attach `browser.on('targetcreated', ...)` to patch new pages/targets.

**Step 4: Run unit tests**
Run required commands:
```bash
npm test tests/SignupFactoryAboutYou.test.js
npm test tests/ChatGPTStateManager.test.js
npm test tests/BrowserLaunchConfig.test.js
```

---

### Task 3: Make BLOCKED handling bounded + restart-capable (no artifact spam)

**Files:**
- Modify: `src/SignupFactory.js`

**Steps:**
1. Detect Turnstile iframe (`Iframe "Widget containing a Cloudflare security challenge"`).
2. Only capture BLOCKED artifacts:
   - on first entry to BLOCKED
   - on mode changes (verifying → checkbox)
   - before restart
   - on final failure
3. Replace long blind waits with a polling loop:
   - re-snapshot every 1s
   - click checkbox at most N times when present
   - if still BLOCKED after `CLOUDFLARE_MAX_MS` (env override), perform up to `MAX_BLOCKED_RESTARTS` restarts.
4. On restart, capture artifacts, relaunch browser, re-warmup to `https://chatgpt.com/auth/login`.

---

### Task 4: Add a warm-up sequence for cold-start (no random sleeps)

**Files:**
- Modify: `src/SignupFactory.js`

**Steps:**
- Replace the fixed initial `setTimeout(3000)` with `navigate → snapshot-poll until non-trivial`.
- Visit:
  1) `https://chatgpt.com/`
  2) `https://chatgpt.com/auth/login`
- After each navigate, poll snapshots until either state != UNKNOWN or `RootWebArea url=` matches expected.

---

### Task 5: Verification runs (evidence)

**Step 1: 3 headless cold-start runs**
Run exactly:
```bash
export USER_DATA_DIR=$(mktemp -d)
MAX_RUN_MS=300000 STEP_TIMEOUT_MS=60000 HEADLESS=true STEALTH=true node --env-file=../../.env src/index.js
```
Repeat 3 times; all must reach Subscribe-click progress verification.

### Future Recommendation: Playwright Backend

If Puppeteer-based stealth and the above hardening measures still fail to provide 100% stability against Cloudflare's evolving Turnstile challenges, we recommend migrating to a **Playwright-based backend**.

**Why Playwright?**
- **Stronger Fingerprint Control**: Playwright's `browserContext` provides more granular and native control over timezone, locale, and permissions without relying solely on JS-level patches.
- **Better CDP Integration**: Playwright's architecture is built on top of the Chrome DevTools Protocol in a way that is often harder for bot-detection scripts to distinguish from real user interaction.
- **Playwright-extra**: Similar to Puppeteer-extra, it has a robust stealth plugin ecosystem.
- **Browser Diversity**: Easily switch to Firefox or WebKit to bypass Chrome-specific detection heuristics.

**Proposed Backend Switch:**
Add `BROWSER_BACKEND=playwright` and `BROWSER_ENGINE=chromium` to env. Modify `BrowserLauncher` to branch based on `BROWSER_BACKEND`.
