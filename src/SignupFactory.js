import { tools } from '../chrome-devtools-mcp/build/src/tools/tools.js';
import { BrowserLauncher } from './BrowserLauncher.js';
import { DEFAULT_USER_AGENT, getBrowserConfig } from './BrowserLaunchConfig.js';
import { McpContext } from '../chrome-devtools-mcp/build/src/McpContext.js';
import { McpResponse } from '../chrome-devtools-mcp/build/src/McpResponse.js';
import { logger } from '../chrome-devtools-mcp/build/src/logger.js';
import { loadIssueDescriptions } from '../chrome-devtools-mcp/build/src/issue-descriptions.js';
import { AgentMailProvider } from './AgentMailProvider.js';
import { ChatGPTStateManager } from './ChatGPTStateManager.js';
import { getRunConfig } from './RunConfig.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { resolveArtifactPath } from './artifacts/pathUtils.js';

// Polyfills for browser environment
Object.defineProperty(global, 'navigator', {
    value: { userAgent: DEFAULT_USER_AGENT },
    configurable: true,
    enumerable: true,
    writable: true
});
Object.defineProperty(global, 'window', {
    value: { 
        location: { pathname: '/' },
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s) => Buffer.from(s, 'binary').toString('base64')
    },
    configurable: true,
    enumerable: true,
    writable: true
});
global.self = global;

const PROFILE_DIR = path.join(os.homedir(), '.cache', 'chatgpt-factory-profile');

export class SignupFactory {
    constructor(agentMailApiKey, options = {}) {
        this.onEvent = options.onEvent || (() => {});
        this.onCheckpoint = options.onCheckpoint || (async () => true);
        this.emailProvider = new AgentMailProvider(agentMailApiKey);
        this.stateManager = new ChatGPTStateManager();
        this.browser = null;
        this.context = null;
        this.email = options.email || null;
        this.agentMailInbox = options.agentMailInbox || null;
        this.password = options.password || 'AutomationTest123!';
        this.userDataDir = options.userDataDir || PROFILE_DIR;
        this.headless = options.headless ?? false;
        this.runConfig = options.runConfig || getRunConfig();

        // If set, all screenshots + snapshots written by this process should go into this directory.
        // (Used by the Rich TUI artifact bundling.)
        this.artifactDir = options.artifactDir || null;

        // BLOCKED/Cloudflare episode tracking
        this.blockedRestartCount = 0;
        this._blockedMode = null;
        this._blockedClicks = 0;

        // Auth error page loop tracking
        this._authErrorCount = 0;
    }

    emitEvent(type, data = {}) {
        this.onEvent({ type, ...data, timestamp: Date.now() });
    }

    emitArtifactWritten(kind, filePath) {
        this.emitEvent('artifact:written', { kind, path: filePath });
    }

    artifactPath(filePath) {
        const p = resolveArtifactPath(this.artifactDir, filePath);
        if (!p) return p;
        try {
            const dir = path.dirname(p);
            if (dir && dir !== '.' && dir !== '/') {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch {}
        return p;
    }

    async init() {
        await loadIssueDescriptions();

        this.browserCfg = getBrowserConfig(process.env);
        console.log(`Browser config: headless=${this.headless} stealth=${this.browserCfg.stealth} timezone=${this.browserCfg.timezone} lang=${this.browserCfg.lang}`);

        // Cloudflare/Turnstile is highly sensitive to headless fingerprinting.
        // Optionally enable puppeteer-extra stealth via STEALTH=true.
        this.browser = await BrowserLauncher.launch({
            headless: this.headless,
            userDataDir: this.userDataDir,
            env: process.env,
        });

        // Apply best-effort JS-level patches (and timezone/headers) to every page.
        // (Stealth plugin may already cover most of this; we keep it as defense-in-depth.)
        await this.installPagePatches();

        this.context = await McpContext.from(this.browser, logger, {});
    }

    async installPagePatches() {
        this._patchedPages = this._patchedPages || new WeakSet();

        const pages = await this.browser.pages();
        for (const page of pages) {
            await this.patchPage(page);
        }

        // Patch all future pages/targets as well.
        if (!this._targetListenerInstalled) {
            this._targetListenerInstalled = true;
            this.browser.on('targetcreated', async (target) => {
                try {
                    const page = await target.page();
                    if (page) await this.patchPage(page);
                } catch {}
            });
        }
    }

    async patchPage(page) {
        if (!page) return;
        if (this._patchedPages?.has(page)) return;
        this._patchedPages?.add(page);

        const cfg = this.browserCfg || getBrowserConfig(process.env);

        try { await page.setUserAgent(cfg.userAgent); } catch {}
        try { await page.setExtraHTTPHeaders({ 'Accept-Language': cfg.lang }); } catch {}
        try { await page.emulateTimezone(cfg.timezone); } catch {}

        // JS-level patches must be installed before navigation to be effective.
        // When STEALTH=true, puppeteer-extra-plugin-stealth already applies a curated set of patches.
        // Our old manual patches (plugins/deviceMemory/etc) can actually worsen fingerprint consistency,
        // so we skip them unless explicitly forced.
        const forceJsPatches = String(process.env.FORCE_JS_PATCHES || '').toLowerCase() === 'true';
        if (!cfg.stealth || forceJsPatches) {
            try {
                await page.evaluateOnNewDocument((lang, userAgent) => {
                    const langs = String(lang || 'en-US,en')
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean);

                    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
                    try { Object.defineProperty(navigator, 'languages', { get: () => langs }); } catch {}

                    const ua = String(userAgent || '');
                    let platform = 'Linux x86_64';
                    if (/Macintosh|Mac OS X/i.test(ua)) platform = 'MacIntel';
                    else if (/Windows/i.test(ua)) platform = 'Win32';

                    try { Object.defineProperty(navigator, 'platform', { get: () => platform }); } catch {}

                    try {
                        // eslint-disable-next-line no-undef
                        window.chrome = window.chrome || { runtime: {} };
                    } catch {}

                    // Some bot checks probe permissions API behavior.
                    try {
                        const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
                        if (originalQuery) {
                            window.navigator.permissions.query = (parameters) => {
                                if (parameters && parameters.name === 'notifications') {
                                    // eslint-disable-next-line no-undef
                                    return Promise.resolve({ state: Notification.permission });
                                }
                                return originalQuery(parameters);
                            };
                        }
                    } catch {}
                }, cfg.lang, cfg.userAgent);
            } catch {}
        }
    }

    async callTool(name, params = {}) {
        // Route screenshots into the per-run artifact directory when configured.
        if (name === 'take_screenshot' && params && params.filePath) {
            params = { ...params, filePath: this.artifactPath(params.filePath) };
        }

        console.log(`>> [${name}] calling with ${JSON.stringify(params)}`);
        const tool = tools.find(t => t.name === name);
        if (!tool) throw new Error(`Tool ${name} not found`);
        const response = new McpResponse();
        if (params.uid) await this.context.createTextSnapshot(false);
        this.lastToolError = null;
        try {
            await tool.handler({ params }, response, this.context);
            if (name === 'take_screenshot' && params && params.filePath) {
                this.emitArtifactWritten('screenshot', params.filePath);
            }
        } catch (e) {
            this.lastToolError = e?.message || String(e);
            console.error(`[Tool ${name}] Execution error:`, this.lastToolError);
            if (params.failOnError) throw e;
        }
        // Sync context
        const pages = await this.browser.pages();
        const bestUrl = selectBestPageFromUrls(pages.map(page => page.url()));
        const targetPage = bestUrl ? [...pages].reverse().find(page => page.url() === bestUrl) : pages[pages.length - 1];
        if (targetPage) await this.context.selectPage(targetPage);
        const res = await response.handle(name, this.context);
        if (!res || !res.content) return [{ type: 'text', text: '' }];
        console.log(`>> [${name}] response: ${res.content[0].text.substring(0, 50)}...`);
        return res.content;
    }

    async getSnapshot() {
        let lastText = '';
        for (let attempt = 0; attempt < 3; attempt++) {
            const resp = await this.callTool('take_snapshot', { verbose: true });
            const text = (resp && resp[0] && resp[0].text) || '';
            lastText = text;
            if (text.length > 200) return text;
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, this.runConfig.SNAPSHOT_RETRY_MS));
            }
        }
        return lastText;
    }

    async waitForUsefulSnapshot(snapshot, tag, timeoutMs = 15000) {
        let s = snapshot || '';
        const start = Date.now();
        while ((Date.now() - start) < timeoutMs) {
            const st = this.stateManager.detectState(s);
            if (s && s.length > 200 && st !== 'UNKNOWN') return s;
            await new Promise(r => setTimeout(r, 500));
            s = await this.getSnapshot();
        }

        // Ambiguous warm-up: capture once, then proceed (main loop will fail fast if still unusable).
        await this.captureArtifacts(`ambiguous_${tag}_warmup_timeout`, s);
        return s;
    }

    async warmup() {
        // Within a fresh profile, do a minimal warm-up sequence to reduce Cloudflare sensitivity.
        // Always: navigate → snapshot → (optional screenshot elsewhere) → parse → act → re-snapshot.
        let snap = await this.navigateWithResnapshot('https://chatgpt.com/', 'warmup_home', null);
        snap = await this.waitForUsefulSnapshot(snap, 'warmup_home');

        snap = await this.navigateWithResnapshot('https://chatgpt.com/auth/login', 'warmup_login', snap);
        snap = await this.waitForUsefulSnapshot(snap, 'warmup_login');

        return snap;
    }

    async run() {
        console.log('--- SIGNUP FACTORY START ---');
        this.emitEvent('run:start');

        try {
            this.startTime = Date.now();
            const result = await this._runInternal();
            this.emitEvent('run:success');
            return result;
        } catch (e) {
            this.emitEvent('run:failure', { reason: e.message });
            throw e;
        }
    }

    async _runInternal() {
        let snapshot = await this.warmup();
        let state = this.stateManager.detectState(snapshot);

        // Always provision an inbox if not provided.
        // Even if we start already logged in, we still need an email for checkout.
        if (!this.email) {
            const inbox = await this.emailProvider.createInbox();
            this.email = inbox.inbox_id;
            this.agentMailInbox = inbox.inbox_id;
            console.log('Target Email:', this.email);
        }

        if (state === 'CHAT_INTERFACE') {
            console.log('Detected existing session. Proceeding to verification.');
        } else if (state !== 'UNKNOWN' && state !== 'ACCESS_DENIED') {
            console.log(`Detected state ${state}. Continuing flow.`);
        } else {
            console.log('No existing session or blocked. Navigating to login.');
            snapshot = await this.navigateWithResnapshot('https://chatgpt.com/auth/login', 'startup_to_login', snapshot);
            state = this.stateManager.detectState(snapshot);
        }

        let attempts = 0;
        let lastState = null;
        let stateCounter = 0;
        let stateStartTime = Date.now();

        while (attempts < 60) {
            if (Date.now() - this.startTime > this.runConfig.MAX_RUN_MS) {
                await this.failWithDebug('MAX_RUN_MS_EXCEEDED', snapshot);
            }

            attempts++;
            snapshot = await this.getSnapshot();

            // Always: snapshot → screenshot → parse → act → re-snapshot
            try {
                await this.callTool('take_screenshot', { filePath: `step_${attempts}_preparse_${this.timestampForFile()}.png` });
            } catch {}

            const debugSnapPath = this.artifactPath('debug_snapshot.txt');
            fs.writeFileSync(debugSnapPath, snapshot);
            this.emitArtifactWritten('snapshot', debugSnapPath);
            state = this.stateManager.detectState(snapshot);
            console.log(`[Step ${attempts}] State: ${state}`);
            this.emitEvent('state:change', { state, attempts });

            // UNKNOWN is an ambiguous transient state (often during redirects after "Claim free offer").
            // Rules: capture artifacts immediately, then bounded retry with re-snapshot verification.
            if (state === 'UNKNOWN') {
                if (!this._unknownFirstSeenAt) {
                    this._unknownFirstSeenAt = Date.now();
                    await this.captureArtifacts('ambiguous_state_unknown', snapshot);
                }

                const deadline = Date.now() + 15000;
                while (Date.now() < deadline) {
                    // During UNKNOWN, also watch for checkout.
                    if (isCheckoutSnapshot(snapshot) || await this.isStripeTabOpen()) {
                        console.log('Detected checkout page (from UNKNOWN). Completing checkout form...');
                        await this.completeCheckoutForm(snapshot);
                        return true;
                    }

                    await new Promise(r => setTimeout(r, 750));
                    snapshot = await this.getSnapshot();
                    const st = this.stateManager.detectState(snapshot);
                    if (st !== 'UNKNOWN') {
                        state = st;
                        this._unknownFirstSeenAt = null;
                        console.log(`[Step ${attempts}] Resolved UNKNOWN -> ${state}`);
                        break;
                    }
                }

                if (state === 'UNKNOWN') {
                    await this.captureArtifacts('ambiguous_state_unknown_timeout', snapshot);
                    await this.failWithDebug('AMBIGUOUS_STATE: UNKNOWN', snapshot);
                }
            } else {
                this._unknownFirstSeenAt = null;
            }

            // If we ever land on checkout directly, complete it before treating the run as done.
            if (isCheckoutSnapshot(snapshot) || await this.isStripeTabOpen()) {
                console.log('Detected checkout page. Completing checkout form...');
                await this.completeCheckoutForm(snapshot);
                return true;
            }

            if (state === 'CHAT_INTERFACE') {
                if (!this.hasVerifiedChat) {
                    console.log('Reached ChatGPT. Verifying logged-in state (passive)...');
                    await this.verifyAccount(snapshot);
                    this.hasVerifiedChat = true;
                }
                // Do not return here: we must proceed to the Business/Team trial flow.
            }

            if (state === lastState) {
                stateCounter++;
            } else {
                lastState = state;
                stateCounter = 1;
                stateStartTime = Date.now();
            }

            // Cloudflare/Turnstile may require >60s on some cold starts.
            // Manage it with a separate bounded timer to avoid generic STEP_TIMEOUT churn.
            if (state === 'BLOCKED') {
                if (!this.blockedFirstSeenAt) this.blockedFirstSeenAt = Date.now();
                const blockedElapsed = Date.now() - this.blockedFirstSeenAt;
                if (blockedElapsed > 180000) {
                    await this.failWithDebug('CLOUDFLARE_BLOCKED_TIMEOUT', snapshot);
                }
                // Prevent generic stuck/step timers from firing while we are in BLOCKED.
                stateStartTime = Date.now();
                stateCounter = 1;
            } else {
                this.blockedFirstSeenAt = null;
                this._blockedMode = null;
                this._blockedClicks = 0;
            }

            if (state !== 'AUTH_ERROR') {
                this._authErrorCount = 0;
            }

            if (Date.now() - stateStartTime > this.runConfig.STEP_TIMEOUT_MS) {
                await this.failWithDebug(`STEP_TIMEOUT: ${state}`, snapshot);
            }

            if (stateCounter > this.runConfig.STATE_STUCK_LIMIT) {
                await this.failWithDebug(`STUCK_STATE: ${state}`, snapshot);
            }

            try {
                const finished = await this.handleState(state, snapshot, stateCounter);
                if (finished === true) return true;
            } catch (e) {
                await this.failWithDebug(`STATE_ERROR: ${state} - ${e.message}`, snapshot);
            }

            await new Promise(r => setTimeout(r, 1000));
        }
        throw new Error('Automation timed out');
    }

    timestampForFile() {
        return new Date().toISOString().replace(/[:.]/g, '-');
    }

    sanitizeForFile(s) {
        return String(s || 'error').replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 160);
    }

    async captureArtifacts(tag, snapshot) {
        const ts = this.timestampForFile();
        const safeTag = this.sanitizeForFile(tag);
        const snapPath = this.artifactPath(`${safeTag}_${ts}.txt`);
        const pngPath = this.artifactPath(`${safeTag}_${ts}.png`);

        if (snapshot) {
            fs.writeFileSync(snapPath, snapshot);
            this.emitArtifactWritten('snapshot', snapPath);
            // Also keep a stable "latest" copy for convenience.
            const latestSnapPath = this.artifactPath('debug_snapshot.txt');
            fs.writeFileSync(latestSnapPath, snapshot);
            this.emitArtifactWritten('snapshot', latestSnapPath);
        }

        try {
            await this.callTool('take_screenshot', { filePath: pngPath });
            // Stable "latest" copy.
            await this.callTool('take_screenshot', { filePath: 'debug_screenshot.png' });
        } catch (e) {
            console.error('Failed to capture screenshot:', e.message);
        }

        return { snapPath, pngPath };
    }

    async failWithDebug(reason, snapshot) {
        console.error(`!!! CRITICAL FAILURE: ${reason} !!!`);
        await this.captureArtifacts(`failure_${reason}`, snapshot);
        throw new Error(reason);
    }

    async clickWithResnapshot(uid, tag, snapshot) {
        // Enforce: snapshot → screenshot → parse → act → re-snapshot
        // Screenshot is taken at the top-level step loop; per-action screenshots are reserved for ambiguity/failure.
        if (!snapshot) {
            snapshot = await this.getSnapshot();
        }

        await this.callTool('click', { uid, failOnError: true });
        return await this.getSnapshot();
    }

    async navigateWithResnapshot(url, tag, snapshot) {
        // Enforce: snapshot → screenshot → parse → act → re-snapshot
        // Screenshot is taken at the top-level step loop; per-action screenshots are reserved for ambiguity/failure.
        if (!snapshot) {
            snapshot = await this.getSnapshot();
        }

        await this.callTool('navigate_page', { url });
        return await this.getSnapshot();
    }

    async pressKeyWithResnapshot(key, tag, snapshot) {
        // Enforce: snapshot → screenshot → parse → act → re-snapshot
        // Screenshot is taken at the top-level step loop; per-action screenshots are reserved for ambiguity/failure.
        if (!snapshot) {
            snapshot = await this.getSnapshot();
        }

        await this.callTool('press_key', { key });
        return await this.getSnapshot();
    }

    async fillField(uid, value, tag = 'fill', snapshot = null, opts = {}) {
        const { tabAfter = true } = opts;

        // click → re-snapshot
        let post = await this.clickWithResnapshot(uid, `${tag}_click`, snapshot);

        // fill → (optional blur) → re-snapshot
        await this.callTool('fill', { uid, value, failOnError: true });
        if (tabAfter) {
            // Trigger blur/validation reliably on React forms.
            await this.callTool('press_key', { key: 'Tab' });
        }
        post = await this.getSnapshot();
        return post;
    }

    async selectDropdownValue(dropdownUid, labelRegexes, tag, snapshot) {
        if (!dropdownUid) {
            await this.failWithDebug(`DROPDOWN_UID_MISSING: ${tag}`, snapshot);
        }
        if (!Array.isArray(labelRegexes) || labelRegexes.length === 0) {
            await this.failWithDebug(`DROPDOWN_LABELS_MISSING: ${tag}`, snapshot);
        }

        let currentSnapshot = snapshot;

        // Open dropdown
        currentSnapshot = await this.clickWithResnapshot(dropdownUid, `${tag}_open`, currentSnapshot);

        // Find an option to click.
        const optionUid = findUidMatchingAnyLine(currentSnapshot, labelRegexes, {
            excludeUids: [dropdownUid],
            excludeHaspopup: true,
        });

        if (!optionUid) {
            await this.captureArtifacts(`ambiguous_${tag}_option_not_found`, currentSnapshot);
            await this.failWithDebug(`DROPDOWN_OPTION_NOT_FOUND: ${tag}`, currentSnapshot);
        }

        // Click option
        currentSnapshot = await this.clickWithResnapshot(optionUid, `${tag}_select`, currentSnapshot);
        return currentSnapshot;
    }

    async selectYearDropdownValue(dropdownUid, tag, snapshot, opts = {}) {
        const { preferredYear = 1990, minAgeYears = 20 } = opts;
        const minYear = new Date().getFullYear() - minAgeYears;

        let currentSnapshot = snapshot;
        currentSnapshot = await this.clickWithResnapshot(dropdownUid, `${tag}_open`, currentSnapshot);

        const yearUid = findYearOptionUid(currentSnapshot, { preferredYear, maxYear: minYear });
        if (!yearUid) {
            await this.captureArtifacts(`ambiguous_${tag}_year_option_not_found`, currentSnapshot);
            await this.failWithDebug(`YEAR_OPTION_NOT_FOUND: ${tag}`, currentSnapshot);
        }

        currentSnapshot = await this.clickWithResnapshot(yearUid, `${tag}_select`, currentSnapshot);
        return currentSnapshot;
    }

    getCloudflareChallengeInfo(snapshot) {
        const s = snapshot || '';

        const hasIframe = /Iframe "Widget containing a Cloudflare security challenge"/i.test(s) || /challenges\.cloudflare\.com\//i.test(s);
        const verifying = /StaticText "Verifying\.\.\."|Checking your Browser|Just a moment\.\.\./i.test(s);

        const checkbox =
            s.match(/uid=(\d+_\d+) checkbox "Verify you are human"/i) ||
            s.match(/uid=(\d+_\d+) checkbox/i) ||
            s.match(/uid=(\d+_\d+) button "Verify you are human"/i);

        if (checkbox) {
            return { mode: 'checkbox', checkboxUid: checkbox[1], hasIframe };
        }
        if (verifying || hasIframe) {
            return { mode: 'verifying', checkboxUid: null, hasIframe };
        }
        return { mode: 'blocked', checkboxUid: null, hasIframe };
    }

    async clickCloudflareCheckboxDirect() {
        // Try to click the Turnstile checkbox via real DOM events inside the Cloudflare frame.
        // This is more reliable than accessibility-level clicks in some iframe variants.
        const pages = await this.browser.pages();
        const page = [...pages].reverse().find(p => p.url() && p.url() !== 'about:blank') || pages[0];
        if (!page) throw new Error('NO_PAGE');

        const frames = page.frames();
        const cfFrame = frames.find(f => {
            const u = f.url() || '';
            return u.includes('challenges.cloudflare.com') || u.includes('/turnstile/');
        });
        if (!cfFrame) throw new Error('CLOUDFLARE_FRAME_NOT_FOUND');

        // Cloudflare often renders a simple input checkbox.
        const selectors = [
            'input[type="checkbox"]',
            'label input[type="checkbox"]',
            '#challenge-stage input[type="checkbox"]',
        ];

        for (const sel of selectors) {
            try {
                const handle = await cfFrame.waitForSelector(sel, { timeout: 1500, visible: true });
                if (!handle) continue;
                await handle.click({ delay: 50 });
                return true;
            } catch {}
        }

        // Fallback: click the label text container.
        const labelSelectors = ['label', '[role="checkbox"]'];
        for (const sel of labelSelectors) {
            try {
                const handle = await cfFrame.waitForSelector(sel, { timeout: 1500, visible: true });
                if (!handle) continue;
                await handle.click({ delay: 50 });
                return true;
            } catch {}
        }

        throw new Error('CLOUDFLARE_CHECKBOX_NOT_FOUND');
    }

    async clickUidWithPuppeteerHandle(uid) {
        if (!uid) throw new Error('UID_MISSING');
        const handle = await this.context.getElementByUid(uid);
        if (!handle) throw new Error(`UID_HANDLE_NOT_FOUND: ${uid}`);

        // Try a more human-like mouse interaction first (helps on some Turnstile variants).
        try {
            const box = await handle.boundingBox();
            const frame = handle.frame?.();
            const page = frame?.page?.();
            if (box && page) {
                const x = box.x + box.width / 2;
                const y = box.y + box.height / 2;

                await page.mouse.move(x - 10, y - 10, { steps: 5 });
                await page.mouse.move(x, y, { steps: 6 });
                await page.mouse.down();
                await new Promise(r => setTimeout(r, 75));
                await page.mouse.up();
                return true;
            }
        } catch {}

        await handle.click({ delay: 75 });
        return true;
    }

    async handleState(state, snapshot, stateCounter = 1) {
        let acted = false;
        switch (state) {
            case 'BUSINESS_TRIAL_PLAN_PICKER': {
                let currentSnapshot = snapshot;

                // Optional: ensure the default seat count is 5.
                const seatsUid = currentSnapshot.match(/uid=(\d+_\d+) spinbutton[^\n]*\bvaluetext="?5"?/i) ||
                                 currentSnapshot.match(/uid=(\d+_\d+) spinbutton[^\n]*\bvaluemin="2"/i);
                if (seatsUid) {
                    try {
                        currentSnapshot = await this.fillField(seatsUid[1], '5', 'plan_picker_users', currentSnapshot);
                    } catch (e) {
                        await this.captureArtifacts('ambiguous_plan_picker_fill_users_failed', currentSnapshot);
                        throw e;
                    }
                }

                // Ensure Monthly option is selected if visible.
                const monthlyRadio = currentSnapshot.match(/uid=(\d+_\d+) radio "[^"]*Monthly[^"]*"/i);
                if (monthlyRadio && !uidIsChecked(currentSnapshot, monthlyRadio[1])) {
                    currentSnapshot = await this.clickWithResnapshot(monthlyRadio[1], 'plan_picker_monthly', currentSnapshot);
                }

                const continueBtn = currentSnapshot.match(/uid=(\d+_\d+) button "Continue to billing"/i);
                if (!continueBtn) {
                    await this.captureArtifacts('ambiguous_plan_picker_no_continue', currentSnapshot);
                    await this.failWithDebug('PLAN_PICKER_CONTINUE_NOT_FOUND', currentSnapshot);
                }

                currentSnapshot = await this.clickWithResnapshot(continueBtn[1], 'plan_picker_continue', currentSnapshot);
                acted = true;

                // Verify transition: plan picker should disappear or checkout should appear.
                const deadline = Date.now() + 20000;
                while (Date.now() < deadline) {
                    if (isCheckoutSnapshot(currentSnapshot) || await this.isStripeTabOpen()) {
                        console.log('Detected checkout page after plan picker. Completing checkout form...');
                        await this.completeCheckoutForm(currentSnapshot);
                        return true;
                    }

                    const st = this.stateManager.detectState(currentSnapshot);
                    if (st !== 'BUSINESS_TRIAL_PLAN_PICKER') {
                        return false;
                    }

                    await new Promise(r => setTimeout(r, 750));
                    currentSnapshot = await this.getSnapshot();
                }

                await this.captureArtifacts('ambiguous_plan_picker_no_transition', currentSnapshot);
                await this.failWithDebug('PLAN_PICKER_NO_TRANSITION', currentSnapshot);
                break;
            }
            case 'PRICING': {
                let currentSnapshot = snapshot;

                // Pricing page (#pricing) path: click the Business trial CTA to enter the funnel.
                const tryUid = findPricingTryCtaUid(currentSnapshot);

                if (!tryUid) {
                    await this.captureArtifacts('ambiguous_pricing_no_try_for_free', currentSnapshot);
                    await this.failWithDebug('PRICING_TRY_FOR_FREE_NOT_FOUND', currentSnapshot);
                }

                currentSnapshot = await this.clickWithResnapshot(tryUid, 'pricing_try_for_free', currentSnapshot);
                acted = true;

                // Verify transition: pricing should move to plan picker or checkout.
                const deadline = Date.now() + 20000;
                while (Date.now() < deadline) {
                    if (isCheckoutSnapshot(currentSnapshot) || await this.isStripeTabOpen()) {
                        console.log('Detected checkout page after pricing CTA. Completing checkout form...');
                        await this.completeCheckoutForm(currentSnapshot);
                        return true;
                    }

                    const st = this.stateManager.detectState(currentSnapshot);
                    if (st !== 'PRICING') {
                        return false;
                    }

                    await new Promise(r => setTimeout(r, 750));
                    currentSnapshot = await this.getSnapshot();
                }

                await this.captureArtifacts('ambiguous_pricing_no_transition', currentSnapshot);
                await this.failWithDebug('PRICING_TRY_FOR_FREE_NO_TRANSITION', currentSnapshot);
                break;
            }
            case 'CHAT_INTERFACE': {
                let currentSnapshot = snapshot;

                // Step 6: click Free offer pill (must not send a chat message).
                const freeOfferBtn = currentSnapshot.match(/uid=(\d+_\d+) button "Free offer"/i);
                const claimBtn = currentSnapshot.match(/uid=(\d+_\d+) button "Claim free offer"/i);
                const upgradeBtn = currentSnapshot.match(/uid=(\d+_\d+) button "Upgrade"/i);

                if (freeOfferBtn) {
                    try {
                        currentSnapshot = await this.clickWithResnapshot(freeOfferBtn[1], 'chat_free_offer_pill', currentSnapshot);
                    } catch (e) {
                        // UIDs can go stale between snapshot parse and click (hydration/rerender). Retry once.
                        if ((e?.message || '').includes('No such element found in the snapshot')) {
                            await this.captureArtifacts('ambiguous_chat_free_offer_uid_missing', currentSnapshot);
                            currentSnapshot = await this.getSnapshot();
                            const retry = currentSnapshot.match(/uid=(\d+_\d+) button "Free offer"/i);
                            if (!retry) {
                                await this.captureArtifacts('ambiguous_chat_free_offer_missing_after_uid_retry', currentSnapshot);
                                // Instead of failing immediately, return false and let the loop retry or force nav.
                                return false;
                            }
                            currentSnapshot = await this.clickWithResnapshot(retry[1], 'chat_free_offer_pill_retry', currentSnapshot);
                        } else {
                            throw e;
                        }
                    }
                    acted = true;

                    // If the modal rendered quickly, proceed immediately.
                    const claimNow = currentSnapshot.match(/uid=(\d+_\d+) button "Claim free offer"/i);
                    if (claimNow) {
                        const start = Date.now();
                        while (uidIsDisabled(currentSnapshot, claimNow[1]) && (Date.now() - start) < 20000) {
                            await new Promise(r => setTimeout(r, 500));
                            currentSnapshot = await this.getSnapshot();

                            // If claim action already navigated to checkout, proceed.
                            if (isCheckoutSnapshot(currentSnapshot) || await this.isStripeTabOpen()) {
                                console.log('Detected checkout page while waiting for Claim button. Completing checkout form...');
                                await this.completeCheckoutForm(currentSnapshot);
                                return true;
                            }
                        }

                        if (uidIsDisabled(currentSnapshot, claimNow[1])) {
                            await this.captureArtifacts('ambiguous_claim_free_offer_disabled', currentSnapshot);
                            await this.failWithDebug('CLAIM_FREE_OFFER_STILL_DISABLED', currentSnapshot);
                        }

                        currentSnapshot = await this.clickWithResnapshot(claimNow[1], 'chat_claim_free_offer', currentSnapshot);

                        // Claim may open a plan picker or checkout immediately.
                        if (isCheckoutSnapshot(currentSnapshot) || await this.isStripeTabOpen()) {
                            console.log('Detected checkout page after Claim free offer. Completing checkout form...');
                            await this.completeCheckoutForm(currentSnapshot);
                            return true;
                        }
                        const stAfter = this.stateManager.detectState(currentSnapshot);
                        if (stAfter === 'BUSINESS_TRIAL_PLAN_PICKER') {
                            return false;
                        }
                    }

                    break;
                }

                // Step 7: click Claim free offer in modal.
                if (claimBtn) {
                    let claimUid = claimBtn[1];
                    const start = Date.now();
                    while ((Date.now() - start) < 20000) {
                        // If we navigated to checkout while the modal updated, proceed.
                        if (isCheckoutSnapshot(currentSnapshot) || await this.isStripeTabOpen()) {
                            console.log('Detected checkout page while waiting for Claim free offer. Completing checkout form...');
                            await this.completeCheckoutForm(currentSnapshot);
                            return true;
                        }

                        const m = currentSnapshot.match(/uid=(\d+_\d+) button "Claim free offer"/i);
                        if (!m) break;
                        claimUid = m[1];
                        if (!uidIsDisabled(currentSnapshot, claimUid)) break;
                        await new Promise(r => setTimeout(r, 500));
                        currentSnapshot = await this.getSnapshot();
                    }

                    const stillThere = currentSnapshot.match(/uid=(\d+_\d+) button "Claim free offer"/i);
                    if (!stillThere) {
                        // Claim button disappeared; treat as progress if we reached plan picker or checkout.
                        if (isCheckoutSnapshot(currentSnapshot) || await this.isStripeTabOpen()) {
                            console.log('Detected checkout page after Claim free offer disappeared. Completing checkout form...');
                            await this.completeCheckoutForm(currentSnapshot);
                            return true;
                        }
                        const st = this.stateManager.detectState(currentSnapshot);
                        if (st !== 'CHAT_INTERFACE') {
                            return false;
                        }

                        await this.captureArtifacts('ambiguous_claim_free_offer_missing', currentSnapshot);
                        // Return false instead of failing to allow retry or force nav.
                        return false;
                    }
                    claimUid = stillThere[1];

                    if (uidIsDisabled(currentSnapshot, claimUid)) {
                        await this.captureArtifacts('ambiguous_claim_free_offer_disabled', currentSnapshot);
                        await this.failWithDebug('CLAIM_FREE_OFFER_STILL_DISABLED', currentSnapshot);
                    }

                    await this.clickWithResnapshot(claimUid, 'chat_claim_free_offer', currentSnapshot);
                    acted = true;
                    break;
                }

                if (upgradeBtn) {
                    console.log('No "Free offer" controls found, but "Upgrade" button is present. Clicking Upgrade...');
                    await this.clickWithResnapshot(upgradeBtn[1], 'chat_upgrade_click', currentSnapshot);
                    acted = true;
                    break;
                }

                // If neither is present, check whether we already progressed.
                if (isCheckoutSnapshot(currentSnapshot) || await this.isStripeTabOpen()) {
                    console.log('Detected checkout page while in CHAT_INTERFACE without Free offer controls. Completing checkout form...');
                    await this.completeCheckoutForm(currentSnapshot);
                    return true;
                }
                if (this.stateManager.detectState(currentSnapshot) === 'BUSINESS_TRIAL_PLAN_PICKER') {
                    return false;
                }

                // Otherwise, wait or force navigation.
                if (stateCounter > 5) {
                    console.log('No offer controls found in CHAT_INTERFACE after 5 attempts. Forcing navigation to pricing...');
                    await this.navigateWithResnapshot('https://chatgpt.com/#pricing', 'chat_force_pricing_nav', currentSnapshot);
                    return false;
                }

                console.log('No offer controls found in CHAT_INTERFACE, waiting for hydration/load...');
                return false;
            }
            case 'AUTH_ERROR': {
                this._authErrorCount = (this._authErrorCount || 0) + 1;
                // Always capture the auth error page for postmortem.
                await this.captureArtifacts(`auth_error_${this._authErrorCount}`, snapshot);

                if (this._authErrorCount > 3) {
                    await this.failWithDebug('AUTH_ERROR_TOO_MANY', snapshot);
                }

                const tryAgainBtn = snapshot.match(/uid=(\d+_\d+) button "Try again"/i);
                if (tryAgainBtn) {
                    await this.clickWithResnapshot(tryAgainBtn[1], 'auth_error_try_again', snapshot);
                } else {
                    await this.navigateWithResnapshot('https://chatgpt.com/auth/login', 'auth_error_nav_login', snapshot);
                }
                acted = true;
                break;
            }
            case 'LANDING': {
                let currentSnapshot = snapshot;
                const loginBtn = currentSnapshot.match(/uid=(\d+_\d+) (?:button|link) "Log in"/i);
                const signupBtn = currentSnapshot.match(/uid=(\d+_\d+) button "Sign up for free"/i);

                const targetBtn = loginBtn || signupBtn;
                if (targetBtn) {
                    console.log(`Clicking ${targetBtn[0]} on landing...`);
                    try {
                        currentSnapshot = await this.clickWithResnapshot(targetBtn[1], 'landing_click', currentSnapshot);
                    } catch (e) {
                        const msg = e?.message || '';
                        // Hydration race: the CTA can become non-interactive/detach between snapshot and click.
                        if (msg.includes('did not become interactive') || msg.includes('No such element found in the snapshot')) {
                            await this.captureArtifacts('ambiguous_landing_click_failed', currentSnapshot);
                            console.log('Landing click failed; falling back to direct navigation to /auth/login');
                            currentSnapshot = await this.navigateWithResnapshot('https://chatgpt.com/auth/login', 'landing_fallback_login_nav', currentSnapshot);
                        } else {
                            throw e;
                        }
                    }

                    // Hydration/navigation race: click may succeed but transition can take a few seconds.
                    const waitForLeaveLanding = async (label, snap) => {
                        let s = snap;
                        let st = this.stateManager.detectState(s);
                        const start = Date.now();
                        while (st === 'LANDING' && (Date.now() - start) < 8000) {
                            await new Promise(r => setTimeout(r, 500));
                            s = await this.getSnapshot();
                            st = this.stateManager.detectState(s);
                        }
                        if (st === 'LANDING') {
                            console.log(`${label}: still on LANDING after wait window`);
                        }
                        return { snapshot: s, state: st };
                    };

                    let next = await waitForLeaveLanding('landing_click', currentSnapshot);
                    let nextState = next.state;
                    currentSnapshot = next.snapshot;

                    if (nextState === 'LANDING') {
                        console.log('Landing click did not transition, retrying once...');

                        // Re-find the CTA in the fresh snapshot; UIDs can change during hydration.
                        const loginBtnRetry = currentSnapshot.match(/uid=(\d+_\d+) (?:button|link) "Log in"/i);
                        const signupBtnRetry = currentSnapshot.match(/uid=(\d+_\d+) button "Sign up for free"/i);
                        const retryBtn = loginBtnRetry || signupBtnRetry || targetBtn;

                        try {
                            currentSnapshot = await this.clickWithResnapshot(retryBtn[1], 'landing_click_retry', currentSnapshot);
                        } catch (e) {
                            const msg = e?.message || '';
                            if (msg.includes('did not become interactive') || msg.includes('No such element found in the snapshot')) {
                                await this.captureArtifacts('ambiguous_landing_click_retry_failed', currentSnapshot);
                                console.log('Landing retry click failed; falling back to direct navigation to /auth/login');
                                await this.navigateWithResnapshot('https://chatgpt.com/auth/login', 'landing_fallback_login_nav', currentSnapshot);
                                acted = true;
                                break;
                            }
                            throw e;
                        }

                        next = await waitForLeaveLanding('landing_click_retry', currentSnapshot);
                        nextState = next.state;
                        currentSnapshot = next.snapshot;
                    }

                    if (nextState === 'LANDING') {
                        // Ambiguous: click didn't transition (hydration race or overlay). Capture and use safe fallback.
                        await this.captureArtifacts('ambiguous_landing_click_no_transition', currentSnapshot);
                        console.log('Landing click did not transition after retry; falling back to direct navigation to /auth/login');
                        currentSnapshot = await this.navigateWithResnapshot('https://chatgpt.com/auth/login', 'landing_fallback_login_nav', currentSnapshot);
                    }
                    acted = true;
                    break;
                }

                if (currentSnapshot.includes('Your session has ended') || currentSnapshot.includes('Continue by logging in') || currentSnapshot.includes('auth/login_with')) {
                    console.log('No CTA found on landing/session-ended. Navigating to login...');
                    await this.navigateWithResnapshot('https://chatgpt.com/auth/login', 'landing_to_login', currentSnapshot);
                    acted = true;
                }
                break;
            }
            case 'LOGIN_EMAIL': {
                let currentSnapshot = snapshot;
                const emailInput = currentSnapshot.match(/uid=(\d+_\d+) textbox "Email address"/i);
                if (!emailInput) break;

                if (uidIsDisabled(currentSnapshot, emailInput[1])) {
                    console.log('Email input is disabled, waiting...');
                    return false;
                }

                currentSnapshot = await this.fillField(emailInput[1], this.email, 'login_email_email', currentSnapshot);

                let continueBtn = currentSnapshot.match(/uid=(\d+_\d+) button "Continue"/i);
                if (continueBtn) {
                    const start = Date.now();
                    while (continueBtn && uidIsDisabled(currentSnapshot, continueBtn[1]) && (Date.now() - start) < 15000) {
                        await new Promise(r => setTimeout(r, 500));
                        currentSnapshot = await this.getSnapshot();
                        continueBtn = currentSnapshot.match(/uid=(\d+_\d+) button "Continue"/i);
                    }

                    if (continueBtn && uidIsDisabled(currentSnapshot, continueBtn[1])) {
                        await this.captureArtifacts('ambiguous_login_email_continue_disabled', currentSnapshot);
                        await this.failWithDebug('LOGIN_EMAIL_CONTINUE_STILL_DISABLED', currentSnapshot);
                    }

                    if (continueBtn) {
                        await this.clickWithResnapshot(continueBtn[1], 'login_email_continue', currentSnapshot);
                        acted = true;
                        break;
                    }
                }

                await this.pressKeyWithResnapshot('Enter', 'login_email_enter', currentSnapshot);
                acted = true;
                break;
            }
            case 'LOGIN_PASSWORD': {
                let currentSnapshot = snapshot;
                const passInput = currentSnapshot.match(/uid=(\d+_\d+) textbox "Password"/i);
                if (!passInput) break;

                if (uidIsDisabled(currentSnapshot, passInput[1])) {
                    console.log('Password input is disabled, waiting...');
                    return false;
                }

                currentSnapshot = await this.fillField(passInput[1], this.password, 'login_password_password', currentSnapshot);

                // Some variants use "Log in" instead of "Continue".
                let continueBtn = currentSnapshot.match(/uid=(\d+_\d+) button "(?:Continue|Log in)"/i);
                if (continueBtn) {
                    const start = Date.now();
                    while (continueBtn && uidIsDisabled(currentSnapshot, continueBtn[1]) && (Date.now() - start) < 15000) {
                        await new Promise(r => setTimeout(r, 500));
                        currentSnapshot = await this.getSnapshot();
                        continueBtn = currentSnapshot.match(/uid=(\d+_\d+) button "(?:Continue|Log in)"/i);
                    }

                    if (continueBtn && uidIsDisabled(currentSnapshot, continueBtn[1])) {
                        await this.captureArtifacts('ambiguous_login_password_continue_disabled', currentSnapshot);
                        await this.failWithDebug('LOGIN_PASSWORD_CONTINUE_STILL_DISABLED', currentSnapshot);
                    }

                    if (continueBtn) {
                        await this.clickWithResnapshot(continueBtn[1], 'login_password_continue', currentSnapshot);
                        acted = true;
                        break;
                    }
                }

                await this.pressKeyWithResnapshot('Enter', 'login_password_enter', currentSnapshot);
                acted = true;
                break;
            }
            case 'OTP_VERIFICATION': {
                // Waiting for the OTP code can take time; the snapshot captured at the top of the loop can go stale.
                // Always re-snapshot AFTER we have the code, then parse UIDs from the fresh snapshot.
                if (!this._otpCode) {
                    const code = await this.emailProvider.waitForCode(this.agentMailInbox || this.email, this.runConfig.OTP_TIMEOUT_MS);
                    if (!code) {
                        throw new Error('OTP_TIMEOUT');
                    }
                    this._otpCode = code;
                }

                let currentSnapshot = await this.getSnapshot();

                const codeInput =
                    currentSnapshot.match(/uid=(\d+_\d+) textbox "(?:Code|Verification code)"/i) ||
                    currentSnapshot.match(/uid=(\d+_\d+) textbox "Code"/i);

                if (!codeInput) {
                    // Likely mid-transition; let the main loop re-snapshot and re-detect.
                    if (!this._otpMissingInputCaptured) {
                        this._otpMissingInputCaptured = true;
                        await this.captureArtifacts('ambiguous_otp_code_input_missing', currentSnapshot);
                    }
                    return false;
                }

                try {
                    currentSnapshot = await this.fillField(codeInput[1], this._otpCode, 'otp_code', currentSnapshot, { tabAfter: false });
                    await this.pressKeyWithResnapshot('Enter', 'otp_enter', currentSnapshot);
                    acted = true;
                } catch (e) {
                    const msg = e?.message || '';
                    // Snapshot staleness can happen if the page re-renders while we're between snapshot and click.
                    if (msg.includes('No such element found in the snapshot')) {
                        if (!this._otpStaleCaptured) {
                            this._otpStaleCaptured = true;
                            await this.captureArtifacts('ambiguous_otp_stale_snapshot', currentSnapshot);
                        }
                        return false;
                    }
                    throw e;
                }

                break;
            }
            case 'ABOUT_YOU': {
                console.log('Handling ABOUT_YOU...');
                let currentSnapshot = snapshot;

                const nameInp = currentSnapshot.match(/uid=(\d+_\d+) (?:textbox|textarea|generic) "Full name"/i);
                if (nameInp) {
                    currentSnapshot = await this.fillField(nameInp[1], 'Agent User', 'about_you_name', currentSnapshot);
                    acted = true;
                }

                const splitDob = detectSplitDobUids(currentSnapshot);
                if (splitDob) {
                    const isDropdown = uidLooksLikeDropdownButton(currentSnapshot, splitDob.day) ||
                                       uidLooksLikeDropdownButton(currentSnapshot, splitDob.month) ||
                                       uidLooksLikeDropdownButton(currentSnapshot, splitDob.year);

                    if (isDropdown) {
                        // Dropdown-button variant (haspopup=listbox): UIDs can change after selecting month/day.
                        // Re-detect DOB UIDs between selections.
                        let dob = splitDob;

                        currentSnapshot = await this.selectDropdownValue(dob.month, [/\bJanuary\b/i, /\bJan\b/i, /\b1\b/], 'about_you_month', currentSnapshot);
                        dob = detectSplitDobUids(currentSnapshot) || dob;

                        currentSnapshot = await this.selectDropdownValue(dob.day, [/\b1\b/, /\b01\b/, /\b1\s+Day\b/i], 'about_you_day', currentSnapshot);
                        dob = detectSplitDobUids(currentSnapshot) || dob;

                        // Year is often defaulted to the current year (invalid age). Select an older year.
                        currentSnapshot = await this.selectYearDropdownValue(dob.year, 'about_you_year', currentSnapshot, { preferredYear: 1990, minAgeYears: 20 });
                    } else {
                        // Spinbutton/textbox variant.
                        currentSnapshot = await this.fillField(splitDob.day, '01', 'about_you_day', currentSnapshot);
                        currentSnapshot = await this.fillField(splitDob.month, '01', 'about_you_month', currentSnapshot);
                        currentSnapshot = await this.fillField(splitDob.year, '1990', 'about_you_year', currentSnapshot);
                    }
                    acted = true;
                } else {
                    const birthdayInp = currentSnapshot.match(/uid=(\d+_\d+) (?:textbox|textarea|generic) "Birthday"/i);
                    if (birthdayInp) {
                        currentSnapshot = await this.fillField(birthdayInp[1], '01/01/1990', 'about_you_birthday', currentSnapshot);
                        acted = true;
                    }
                }

                if (acted) {
                    // Re-snapshot before deciding if we can continue.
                    currentSnapshot = await this.getSnapshot();

                    let contBtn = currentSnapshot.match(/uid=(\d+_\d+) button "(?:Continue|Submit|Done)"/i);
                    if (contBtn) {
                        const start = Date.now();
                        while (contBtn && uidIsDisabled(currentSnapshot, contBtn[1]) && (Date.now() - start) < 20000) {
                            await new Promise(r => setTimeout(r, 500));
                            currentSnapshot = await this.getSnapshot();
                            contBtn = currentSnapshot.match(/uid=(\d+_\d+) button "(?:Continue|Submit|Done)"/i);
                        }

                        if (contBtn && uidIsDisabled(currentSnapshot, contBtn[1])) {
                            await this.captureArtifacts('ambiguous_about_you_continue_disabled', currentSnapshot);
                            await this.failWithDebug('ABOUT_YOU_CONTINUE_STILL_DISABLED', currentSnapshot);
                        }

                        const waitForLeaveAboutYou = async (label, snap) => {
                            let s = snap;
                            let st = this.stateManager.detectState(s);
                            const start = Date.now();
                            while (st === 'ABOUT_YOU' && (Date.now() - start) < 10000) {
                                await new Promise(r => setTimeout(r, 500));
                                s = await this.getSnapshot();
                                st = this.stateManager.detectState(s);
                            }
                            return { snapshot: s, state: st };
                        };

                        if (contBtn) {
                            currentSnapshot = await this.clickWithResnapshot(contBtn[1], 'about_you_continue', currentSnapshot);
                        } else {
                            currentSnapshot = await this.pressKeyWithResnapshot('Enter', 'about_you_enter', currentSnapshot);
                        }

                        let next = await waitForLeaveAboutYou('about_you_continue', currentSnapshot);
                        currentSnapshot = next.snapshot;

                        if (next.state === 'ABOUT_YOU') {
                            // Retry once: re-find the continue button in the fresh snapshot (UIDs can change after validation).
                            await this.captureArtifacts('ambiguous_about_you_no_transition', currentSnapshot);

                            const contBtnRetry = currentSnapshot.match(/uid=(\d+_\d+) button "(?:Continue|Submit|Done)"/i);
                            if (contBtnRetry) {
                                currentSnapshot = await this.clickWithResnapshot(contBtnRetry[1], 'about_you_continue_retry', currentSnapshot);
                            } else {
                                currentSnapshot = await this.pressKeyWithResnapshot('Enter', 'about_you_enter_retry', currentSnapshot);
                            }

                            next = await waitForLeaveAboutYou('about_you_continue_retry', currentSnapshot);
                            currentSnapshot = next.snapshot;

                            if (next.state === 'ABOUT_YOU') {
                                await this.captureArtifacts('ambiguous_about_you_no_transition', currentSnapshot);
                                await this.failWithDebug('ABOUT_YOU_CLICK_NO_TRANSITION', currentSnapshot);
                            }
                        }
                    } else {
                        currentSnapshot = await this.pressKeyWithResnapshot('Enter', 'about_you_enter', currentSnapshot);
                        const next = await (async () => {
                            let s = currentSnapshot;
                            let st = this.stateManager.detectState(s);
                            const start = Date.now();
                            while (st === 'ABOUT_YOU' && (Date.now() - start) < 10000) {
                                await new Promise(r => setTimeout(r, 500));
                                s = await this.getSnapshot();
                                st = this.stateManager.detectState(s);
                            }
                            return { snapshot: s, state: st };
                        })();

                        if (next.state === 'ABOUT_YOU') {
                            await this.captureArtifacts('ambiguous_about_you_no_continue_button', next.snapshot);
                            await this.failWithDebug('ABOUT_YOU_NO_CONTINUE_BUTTON', next.snapshot);
                        }
                    }
                } else if (currentSnapshot.includes("Let's confirm your age")) {
                    // Fail fast with artifacts if we cannot find DOB inputs.
                    await this.captureArtifacts('ambiguous_about_you_no_dob', currentSnapshot);
                    throw new Error('ABOUT_YOU_BIRTHDAY_NOT_FOUND');
                }

                break;
            }
            case 'ONBOARDING': {
                // Onboarding overlays can re-render quickly; element UIDs may go stale between snapshot and click.
                // Use bounded retries with re-snapshot instead of failing fast.
                let currentSnapshot = snapshot;

                for (let attempt = 1; attempt <= 3; attempt++) {
                    const skipBtn = currentSnapshot.match(/uid=(\d+_\d+) button "(?:Skip|Skip Tour)"/i);
                    const nextBtn = currentSnapshot.match(/uid=(\d+_\d+) button "(?:Next|Continue|Okay, let’s go|Okay, let's go|Yes|Stay logged in|Done)"/i);

                    const chosen = skipBtn || nextBtn;
                    if (!chosen) {
                        return false;
                    }

                    try {
                        currentSnapshot = await this.clickWithResnapshot(chosen[1], `onboarding_click_${attempt}`, currentSnapshot);
                    } catch (e) {
                        const msg = e?.message || '';
                        if (msg.includes('No such element found in the snapshot') || msg.includes('did not become interactive')) {
                            if (!this._onboardingClickCaptured) {
                                this._onboardingClickCaptured = true;
                                await this.captureArtifacts('ambiguous_onboarding_click_stale', currentSnapshot);
                            }
                            return false;
                        }
                        throw e;
                    }

                    const st = this.stateManager.detectState(currentSnapshot);
                    if (st !== 'ONBOARDING') {
                        acted = true;
                        break;
                    }

                    // Still onboarding; re-snapshot and try again.
                    await new Promise(r => setTimeout(r, 750));
                    currentSnapshot = await this.getSnapshot();
                }

                return false;
            }
            case 'BLOCKED': {
                console.log('Handling BLOCKED/Turnstile...');
                let currentSnapshot = snapshot;

                // Hard-block variants. Fail fast with artifacts.
                if (/Your browser is out of date|Update your browser|Browser.*out of date/i.test(currentSnapshot)) {
                    await this.failWithDebug('CLOUDFLARE_HARD_BLOCK_OUT_OF_DATE', currentSnapshot);
                }

                const stepMaxMs = Number(process.env.CLOUDFLARE_STEP_MAX_MS || 45000);
                const maxRestarts = Number(process.env.MAX_BLOCKED_RESTARTS || 2);
                const deadline = Date.now() + stepMaxMs;

                while (Date.now() < deadline) {
                    const st = this.stateManager.detectState(currentSnapshot);
                    if (st !== 'BLOCKED') {
                        // Unblocked; let main loop continue.
                        return false;
                    }

                    const cf = this.getCloudflareChallengeInfo(currentSnapshot);

                    // Capture artifacts only when the BLOCKED mode changes (avoids screenshot spam).
                    if (cf.mode !== this._blockedMode) {
                        this._blockedMode = cf.mode;
                        await this.captureArtifacts(`ambiguous_blocked_${cf.mode}`, currentSnapshot);
                    }

                    // If a checkbox is present, attempt a bounded number of clicks.
                    if (cf.checkboxUid && this._blockedClicks < 3) {
                        const clickNum = this._blockedClicks + 1;
                        this._blockedClicks = clickNum;

                        // Clicking Turnstile is ambiguous: capture artifacts before acting.
                        await this.captureArtifacts(`ambiguous_turnstile_click_${clickNum}_pre`, currentSnapshot);

                        let clicked = false;
                        try {
                            clicked = await this.clickUidWithPuppeteerHandle(cf.checkboxUid);
                        } catch (e) {
                            console.log('Turnstile uid handle click failed:', e?.message || String(e));
                        }

                        if (!clicked) {
                            try {
                                clicked = await this.clickCloudflareCheckboxDirect();
                            } catch (e) {
                                console.log('Direct Turnstile click failed:', e?.message || String(e));
                            }
                        }

                        if (!clicked) {
                            currentSnapshot = await this.clickWithResnapshot(cf.checkboxUid, `turnstile_click_${clickNum}`, currentSnapshot);
                        } else {
                            // Enforce: act → re-snapshot.
                            currentSnapshot = await this.getSnapshot();
                        }
                        acted = true;

                        // Wait for a reaction: either we leave BLOCKED or the mode changes.
                        const reactionDeadline = Date.now() + 20000;
                        while (Date.now() < reactionDeadline) {
                            const s2 = await this.getSnapshot();
                            const st2 = this.stateManager.detectState(s2);
                            if (st2 !== 'BLOCKED') return false;

                            const cf2 = this.getCloudflareChallengeInfo(s2);
                            if (cf2.mode !== this._blockedMode) {
                                currentSnapshot = s2;
                                break;
                            }

                            await new Promise(r => setTimeout(r, 500));
                        }

                        // Continue outer loop with latest snapshot.
                        currentSnapshot = await this.getSnapshot();
                        continue;
                    }

                    // Poll for automatic verification.
                    await new Promise(r => setTimeout(r, 1000));
                    currentSnapshot = await this.getSnapshot();
                }

                // BLOCKED did not resolve in the window. Capture once, then optionally restart.
                await this.captureArtifacts('ambiguous_blocked_timeout', currentSnapshot);

                if (this.blockedRestartCount < maxRestarts) {
                    this.blockedRestartCount++;
                    await this.captureArtifacts(`ambiguous_blocked_restart_boundary_${this.blockedRestartCount}`, currentSnapshot);
                    currentSnapshot = await this.restartBrowser(`cloudflare_${this.blockedRestartCount}`, currentSnapshot);
                    // Let main loop continue from the restarted browser.
                    return false;
                }

                await this.failWithDebug('CLOUDFLARE_VERIFICATION_TIMEOUT', currentSnapshot);
                break;
            }
            case 'ACCESS_DENIED':
                await this.failWithDebug('ACCESS_DENIED', snapshot);
                break;
            case 'UNKNOWN':
                await this.failWithDebug('AMBIGUOUS_STATE: UNKNOWN', snapshot);
                break;
        }
        return false;
    }

    async verifyAccount(snapshot) {
        console.log('Verifying chat interface is present (passive mode)...');
        const isPresent = (snap) => {
            // Logged-in verification must be passive and must NOT rely on the mere presence of the chat shell.
            // ChatGPT can show an "Ask anything" shell while still logged out.
            const hasAuthCtas = snap.includes('button "Log in"') || snap.includes('button "Sign up for free"') || snap.includes('link "Log in"');
            if (hasAuthCtas) return false;

            // Strong indicators for authenticated session.
            return (
                snap.includes('button "Open profile menu"') ||
                snap.includes('image "Profile image"')
            );
        };

        if (isPresent(snapshot)) {
            console.log('--- VERIFICATION SUCCESS: Chat interface indicators found ---');
            return;
        }
        
        // Try one more fresh snapshot if not found
        const freshSnapshot = await this.getSnapshot();
        if (isPresent(freshSnapshot)) {
            console.log('--- VERIFICATION SUCCESS: Chat interface indicators found on second attempt ---');
            return;
        }
        
        await this.failWithDebug('VERIFICATION_FAILED: Chat interface indicators not found', freshSnapshot);
    }

    async captureCheckoutSnapshot(tag) {
        const snapshot = await this.getSnapshot();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const pngPath = this.artifactPath(`checkout_${tag}_${timestamp}.png`);
        await this.callTool('take_screenshot', { filePath: pngPath });
        return snapshot;
    }

    async captureCheckoutFailure(reason, snapshot) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const snap = snapshot || (await this.getSnapshot());
        const snapPath = this.artifactPath(`checkout_failure_${reason}_${timestamp}.txt`);
        const pngPath = this.artifactPath(`checkout_failure_${reason}_${timestamp}.png`);
        fs.writeFileSync(snapPath, snap);
        this.emitArtifactWritten('snapshot', snapPath);
        await this.callTool('take_screenshot', { filePath: pngPath });
        return snap;
    }

    async clickWithFail(uid, reason, snapshot) {
        // Deprecated: prefer clickWithResnapshot. Kept for compatibility.
        try {
            await this.clickWithResnapshot(uid, `clickWithFail_${reason}`, snapshot);
        } catch (e) {
            const snap = await this.captureCheckoutFailure(reason, snapshot);
            await this.failWithDebug(`${reason}: ${e.message}`, snap);
        }
    }

    async isStripeTabOpen() {
        const pages = await this.browser.pages();
        return pages.some(p => isStripeCheckoutUrl(p.url()));
    }

    async waitForStripeCheckout(startTime, maxWaitMs = 10000) {
        const deadline = startTime + maxWaitMs;
        while (Date.now() < deadline) {
            if (await this.isStripeTabOpen()) return true;
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    }

    collectAllFrames(rootFrame) {
        const out = [];
        const visit = (frame) => {
            out.push(frame);
            for (const child of frame.childFrames?.() ?? []) visit(child);
        };
        visit(rootFrame);
        return out;
    }

    async typeIntoFirstMatching(frames, selectors, value, label) {
        for (const frame of frames) {
            for (const selector of selectors) {
                const handle = await frame.$(selector);
                if (!handle) continue;
                try {
                    await handle.click({ clickCount: 3 });
                    await frame.page().keyboard.press('Backspace');
                    await frame.type(selector, value, { delay: 10 });
                    return;
                } finally {
                    await handle.dispose?.();
                }
            }
        }
        throw new Error(`${label} input not found`);
    }

    async fillStripePaymentFrame(frameUid) {
        const iframeHandle = await this.context.getElementByUid(frameUid);
        const frame = await iframeHandle.contentFrame();
        if (!frame) throw new Error(`Payment iframe uid ${frameUid} has no contentFrame()`);

        // Stripe iframes can take a while to render their internal inputs.
        // Retry instead of failing fast on "input not found".
        let lastErr = null;
        for (let attempt = 1; attempt <= 12; attempt++) {
            try {
                await this.fillStripePaymentFields(frame);
                return;
            } catch (e) {
                lastErr = e;
                const msg = e?.message || '';
                if (msg.includes('card number input not found') || msg.includes('expiry input not found') || msg.includes('cvc input not found')) {
                    await new Promise(r => setTimeout(r, 1500));
                    continue;
                }
                throw e;
            }
        }
        throw lastErr || new Error('Stripe payment frame fill failed');
    }

    async fillStripePaymentFields(rootFrame) {
        const frames = this.collectAllFrames(rootFrame);

        await this.typeIntoFirstMatching(frames, [
            'input[name="cardnumber"]',
            'input[autocomplete="cc-number"]',
            'input[aria-label*="card number" i]',
            'input[placeholder*="Card number" i]',
        ], '4242424242424242', 'card number');

        await this.typeIntoFirstMatching(frames, [
            'input[name="exp-date"]',
            'input[autocomplete="cc-exp"]',
            'input[aria-label*="expiration" i]',
            'input[placeholder*="MM" i]',
            'input[placeholder*="expiry" i]',
        ], '1234', 'expiry');

        await this.typeIntoFirstMatching(frames, [
            'input[name="cvc"]',
            'input[autocomplete="cc-csc"]',
            'input[aria-label*="cvc" i]',
            'input[aria-label*="security" i]',
            'input[placeholder*="CVC" i]',
        ], '123', 'cvc');

        try {
            await this.typeIntoFirstMatching(frames, [
                'input[name="postal"]',
                'input[autocomplete="postal-code"]',
                'input[aria-label*="zip" i]',
                'input[aria-label*="postal" i]',
                'input[placeholder*="ZIP" i]',
                'input[placeholder*="Postal" i]',
            ], '94105', 'postal');
        } catch {
            // Optional
        }
    }

    async fillStripeBillingAddressFrame(frameUid) {
        const iframeHandle = await this.context.getElementByUid(frameUid);
        const frame = await iframeHandle.contentFrame();
        if (!frame) throw new Error(`Billing iframe uid ${frameUid} has no contentFrame()`);

        let lastErr = null;
        for (let attempt = 1; attempt <= 12; attempt++) {
            try {
                await this.fillStripeBillingAddressFields(frame);
                return;
            } catch (e) {
                lastErr = e;
                const msg = e?.message || '';
                if (msg.includes('address line 1 input not found') || msg.includes('postal input not found') || msg.includes('full name input not found')) {
                    await new Promise(r => setTimeout(r, 1500));
                    continue;
                }
                throw e;
            }
        }
        throw lastErr || new Error('Stripe billing frame fill failed');
    }

    async fillStripeBillingAddressFields(rootFrame) {
        const frames = this.collectAllFrames(rootFrame);

        // Name field (often first)
        try {
            await this.typeIntoFirstMatching(frames, [
                'input[name="name"]',
                'input[autocomplete="name"]',
                'input[aria-label*="name" i]',
                'input[placeholder*="Full name" i]',
            ], 'Agent User', 'full name');
        } catch {}

        for (const f of frames) {
            const sel = await f.$('select[name="country"], select[autocomplete="country"]');
            if (!sel) continue;
            try {
                await f.evaluate((el, value) => {
                    el.value = value;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }, sel, 'US');
                break;
            } finally {
                await sel.dispose?.();
            }
        }

        await this.typeIntoFirstMatching(frames, [
            'input[autocomplete="address-line1"]',
            'input[name="addressLine1"]',
            'input[autocomplete="street-address"]',
            'input[aria-label*="address" i]',
        ], '123 Market St', 'address line 1');

        try { await this.typeIntoFirstMatching(frames, ['input[autocomplete="address-line2"]', 'input[name="addressLine2"]'], 'Suite 100', 'address line 2'); } catch {}
        try { await this.typeIntoFirstMatching(frames, ['input[autocomplete="address-level2"]', 'input[name="locality"]', 'input[aria-label*="city" i]'], 'San Francisco', 'city'); } catch {}
        try { await this.typeIntoFirstMatching(frames, ['input[autocomplete="address-level1"]', 'input[name="administrativeArea"]', 'input[aria-label*="state" i]'], 'CA', 'state'); } catch {}
        try { await this.typeIntoFirstMatching(frames, ['input[autocomplete="postal-code"]', 'input[name="postalCode"]', 'input[aria-label*="zip" i]', 'input[aria-label*="postal" i]'], '94105', 'postal'); } catch {}
    }

    async completeCheckoutForm(snapshot) {
        // Ensure we have a fresh snapshot to start with
        let currentSnapshot = await this.captureCheckoutSnapshot('start');

        // Checkout pages (especially Stripe-hosted pay.openai.com) can take a few seconds to hydrate.
        // Initial snapshots are sometimes nearly empty; treat that as ambiguity and poll briefly.
        const isReadyCheckout = (snap) => {
            if (!snap || snap.length < 500) return false;
            return (
                !!findSubscribeUid(snap) ||
                !!findCheckoutCardNumberUid(snap) ||
                !!findCheckoutPaymentFrameUid(snap) ||
                snap.includes('heading "Payment method"') ||
                snap.includes('textbox "Email"') ||
                snap.includes('textbox "Email address"')
            );
        };

        if (!isReadyCheckout(currentSnapshot)) {
            await this.captureArtifacts('ambiguous_checkout_unready_initial', currentSnapshot);
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline && !isReadyCheckout(currentSnapshot)) {
                await new Promise(r => setTimeout(r, 750));
                currentSnapshot = await this.getSnapshot();
            }

            if (!isReadyCheckout(currentSnapshot)) {
                const snap = await this.captureCheckoutFailure('CHECKOUT_UNREADY_TIMEOUT', currentSnapshot);
                await this.failWithDebug('CHECKOUT_UNREADY_TIMEOUT', snap);
            }
        }

        // Email field may be present (Stripe-hosted checkout) or absent (already authenticated checkout).
        const emailUid = findCheckoutEmailUid(currentSnapshot);
        if (emailUid) {
            await this.fillField(emailUid, this.email, 'checkout_email', currentSnapshot);
            // Update snapshot after filling email
            currentSnapshot = await this.captureCheckoutSnapshot('after_email');
        } else {
            console.log('Checkout email field not found; continuing without filling email.');
            currentSnapshot = await this.captureCheckoutSnapshot('no_email');
        }

        // Seats selector (Business trial) can be flaky/hydrating. If it's already 5, don't touch it.
        // If it's not interactive yet, retry a few times instead of failing the whole run.
        let seatsUid = findCheckoutSeatsUid(currentSnapshot);
        if (seatsUid) {
            const seatsAlready5 = (snap, uid) => {
                const re = new RegExp(`uid=${uid} spinbutton[^\\n]*(?:valuetext=\"?5\"?|value=\"5\")`, 'i');
                return re.test(snap);
            };

            if (seatsAlready5(currentSnapshot, seatsUid)) {
                console.log('Checkout seats already set to 5; skipping seat interaction.');
            } else {
                let seatsSnap = currentSnapshot;
                let filled = false;

                for (let attempt = 1; attempt <= 3; attempt++) {
                    seatsUid = findCheckoutSeatsUid(seatsSnap) || seatsUid;
                    if (!seatsUid) break;

                    if (seatsAlready5(seatsSnap, seatsUid)) {
                        filled = true;
                        break;
                    }

                    try {
                        seatsSnap = await this.fillField(seatsUid, '5', 'checkout_seats', seatsSnap);
                        filled = true;
                        break;
                    } catch (e) {
                        const msg = e?.message || '';
                        if (msg.includes('did not become interactive')) {
                            await this.captureArtifacts(`ambiguous_checkout_seats_not_interactive_${attempt}`, seatsSnap);
                            await new Promise(r => setTimeout(r, 1000));
                            seatsSnap = await this.getSnapshot();
                            continue;
                        }
                        throw e;
                    }
                }

                currentSnapshot = seatsSnap;
                if (!filled) {
                    await this.captureArtifacts('ambiguous_checkout_seats_gave_up', currentSnapshot);
                }
            }

            currentSnapshot = await this.captureCheckoutSnapshot('after_seats');
        }

        // Stripe-hosted checkout may expose card fields directly (pay.openai.com) OR via iframes.
        const cardNumberUid = findCheckoutCardNumberUid(currentSnapshot);
        const cardExpUid = findCheckoutCardExpiryUid(currentSnapshot);
        const cardCvcUid = findCheckoutCardCvcUid(currentSnapshot);
        const cardholderUid = findCheckoutCardholderNameUid(currentSnapshot);

        if (cardNumberUid && cardExpUid && cardCvcUid) {
            console.log('Detected inline checkout fields. Filling card + billing via snapshot UIDs...');
            try {
                await this.fillField(cardNumberUid, '4242424242424242', 'checkout_card_number', currentSnapshot);
                currentSnapshot = await this.captureCheckoutSnapshot('after_card_number');

                await this.fillField(cardExpUid, '1234', 'checkout_card_exp', currentSnapshot);
                currentSnapshot = await this.captureCheckoutSnapshot('after_card_exp');

                await this.fillField(cardCvcUid, '123', 'checkout_card_cvc', currentSnapshot);
                currentSnapshot = await this.captureCheckoutSnapshot('after_card_cvc');

                if (cardholderUid) {
                    await this.fillField(cardholderUid, 'Agent User', 'checkout_cardholder', currentSnapshot);
                    currentSnapshot = await this.captureCheckoutSnapshot('after_cardholder');
                }

                const enterManualUid = findEnterAddressManuallyUid(currentSnapshot);
                if (enterManualUid) {
                    currentSnapshot = await this.clickWithResnapshot(enterManualUid, 'checkout_enter_address_manually', currentSnapshot);
                    currentSnapshot = await this.captureCheckoutSnapshot('after_enter_address_manually');
                }

                const addrLine1Uid =
                    (currentSnapshot.match(/uid=(\d+_\d+) textbox "Address line 1"/i) || [])[1] ||
                    (currentSnapshot.match(/uid=(\d+_\d+) textbox "Address"/i) || [])[1];
                const cityUid = (currentSnapshot.match(/uid=(\d+_\d+) textbox "City"/i) || [])[1];
                const stateUid =
                    (currentSnapshot.match(/uid=(\d+_\d+) textbox "State"/i) || [])[1] ||
                    (currentSnapshot.match(/uid=(\d+_\d+) textbox "Province"/i) || [])[1];
                const postalUid =
                    (currentSnapshot.match(/uid=(\d+_\d+) textbox "Postal code"/i) || [])[1] ||
                    (currentSnapshot.match(/uid=(\d+_\d+) textbox "ZIP"/i) || [])[1];
                const addressComboboxUid = (currentSnapshot.match(/uid=(\d+_\d+) combobox "Address"/i) || [])[1];

                if (addrLine1Uid) {
                    await this.fillField(addrLine1Uid, '123 Market St', 'checkout_address1', currentSnapshot);
                    currentSnapshot = await this.captureCheckoutSnapshot('after_address1');
                } else if (addressComboboxUid) {
                    await this.fillField(addressComboboxUid, '123 Market St', 'checkout_address_combobox', currentSnapshot);
                    currentSnapshot = await this.captureCheckoutSnapshot('after_address_combobox');
                } else {
                    const snap = await this.captureCheckoutFailure('CHECKOUT_ADDRESS_LINE1_NOT_FOUND', currentSnapshot);
                    await this.failWithDebug('CHECKOUT_ADDRESS_LINE1_NOT_FOUND', snap);
                }

                if (cityUid) {
                    await this.fillField(cityUid, 'Cape Town', 'checkout_city', currentSnapshot);
                    currentSnapshot = await this.captureCheckoutSnapshot('after_city');
                }

                if (stateUid) {
                    await this.fillField(stateUid, 'Western Cape', 'checkout_state', currentSnapshot);
                    currentSnapshot = await this.captureCheckoutSnapshot('after_state');
                }

                if (postalUid) {
                    await this.fillField(postalUid, '8001', 'checkout_postal', currentSnapshot);
                    currentSnapshot = await this.captureCheckoutSnapshot('after_postal');
                }
            } catch (e) {
                const snap = await this.captureCheckoutFailure('CHECKOUT_INLINE_FILL_FAILED', currentSnapshot);
                await this.failWithDebug(`CHECKOUT_INLINE_FILL_FAILED: ${e.message}`, snap);
            }
        } else {
            const paymentFrameUid = findCheckoutPaymentFrameUid(currentSnapshot);
            const billingFrameUid = findCheckoutBillingFrameUid(currentSnapshot);
            if (!paymentFrameUid || !billingFrameUid) {
                const snap = await this.captureCheckoutFailure('CHECKOUT_PAYMENT_BILLING_FRAME_NOT_FOUND', currentSnapshot);
                await this.failWithDebug('CHECKOUT_PAYMENT_BILLING_FRAME_NOT_FOUND', snap);
            }

            try {
                await this.fillStripePaymentFrame(paymentFrameUid);
                await this.fillStripeBillingAddressFrame(billingFrameUid);
            } catch (e) {
                // Fail fast on payment fill error
                const snap = await this.captureCheckoutFailure('CHECKOUT_PAYMENT_FILL_FAILED', currentSnapshot);
                await this.failWithDebug(`CHECKOUT_PAYMENT_FILL_FAILED: ${e.message}`, snap);
            }
        }

        // One more fresh snapshot before clicking subscribe
        currentSnapshot = await this.captureCheckoutSnapshot('form_filled');
        let subscribeUid = findSubscribeUid(currentSnapshot);
        if (!subscribeUid) {
            const snap = await this.captureCheckoutFailure('CHECKOUT_SUBSCRIBE_NOT_FOUND', currentSnapshot);
            await this.failWithDebug('CHECKOUT_SUBSCRIBE_NOT_FOUND', snap);
        }

        // Stripe checkout requires accepting terms via a checkbox before submitting.
        const termsUid = findCheckoutTermsCheckboxUid(currentSnapshot);
        if (termsUid && !uidIsChecked(currentSnapshot, termsUid)) {
            currentSnapshot = await this.clickWithResnapshot(termsUid, 'checkout_terms_checkbox', currentSnapshot);
            currentSnapshot = await this.captureCheckoutSnapshot('after_terms');

            if (!uidIsChecked(currentSnapshot, termsUid)) {
                await this.captureArtifacts('ambiguous_checkout_terms_not_checked', currentSnapshot);
                await this.failWithDebug('CHECKOUT_TERMS_NOT_CHECKED', currentSnapshot);
            }

            // Terms click can re-render; re-resolve Subscribe uid.
            subscribeUid = findSubscribeUid(currentSnapshot);
            if (!subscribeUid) {
                const snap = await this.captureCheckoutFailure('CHECKOUT_SUBSCRIBE_NOT_FOUND_AFTER_TERMS', currentSnapshot);
                await this.failWithDebug('CHECKOUT_SUBSCRIBE_NOT_FOUND_AFTER_TERMS', snap);
            }
        }

        // Prepare a network watcher before clicking Subscribe. Some Stripe outcomes do not update the DOM promptly.
        const urlMatch = currentSnapshot.match(/RootWebArea[^\n]*url="([^\"]+)"/i);
        const checkoutUrl = urlMatch ? urlMatch[1] : '';
        let checkoutPage = null;
        try {
            const pages = await this.browser.pages();
            if (checkoutUrl) {
                const norm = checkoutUrl.split('#')[0];
                checkoutPage = pages.find(p => (p.url() || '').split('#')[0] === norm) || null;
            }
            if (!checkoutPage) {
                const bestUrl = selectBestPageFromUrls(pages.map(p => p.url()));
                checkoutPage = bestUrl ? pages.find(p => p.url() === bestUrl) : null;
            }
        } catch {}

        const networkPromise = checkoutPage
            ? checkoutPage.waitForResponse(
                (resp) => {
                    try {
                        const method = resp.request().method();
                        if (method !== 'POST') return false;
                        const u = resp.url();
                        return u.includes('stripe.com') || u.includes('pay.openai.com') || u.includes('api.stripe.com');
                    } catch {
                        return false;
                    }
                },
                { timeout: 20000 }
            ).catch(() => null)
            : null;

        this.emitEvent('checkpoint:before_subscribe', { snapshot: currentSnapshot });
        const approved = await this.onCheckpoint({
            type: 'before_subscribe',
            summary: 'Ready to submit billing and start subscription',
            artifacts: { snapshot: currentSnapshot }
        });

        if (!approved) {
            console.log('Checkpoint: subscribe NOT approved. Aborting run.');
            throw new Error('CHECKPOINT_REJECTED');
        }

        // Click Subscribe and verify the page progresses (CTA should not remain visible/enabled).
        currentSnapshot = await this.clickWithResnapshot(subscribeUid, 'checkout_subscribe', currentSnapshot);

        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            const progress = detectCheckoutProgress(currentSnapshot);
            console.log(`Checkout progress check: ${progress.reason}`);

            if (progress.progressed) {
                console.log('Checkout progress detected!');
                return;
            }

            // Also accept a POST network response as a valid reaction to the Subscribe click.
            if (networkPromise) {
                const net = await Promise.race([networkPromise, new Promise(r => setTimeout(() => r(null), 750))]);
                if (net) {
                    console.log(`Checkout network response detected: ${net.status()} ${net.url()}`);
                    await this.captureCheckoutSnapshot('subscribe_network_response');
                    return;
                }
            } else {
                await new Promise(r => setTimeout(r, 750));
            }

            currentSnapshot = await this.getSnapshot();
        }

        const postClickSnapshot = await this.captureCheckoutSnapshot('post_subscribe');
        const finalProgress = detectCheckoutProgress(postClickSnapshot);
        if (!finalProgress.progressed) {
            const snap = await this.captureCheckoutFailure('SUBSCRIBE_CLICK_NO_PROGRESS', postClickSnapshot);
            await this.failWithDebug(`SUBSCRIBE_CLICK_NO_PROGRESS: ${finalProgress.reason}`, snap);
        }
    }

    async restartBrowser(reason, snapshot) {
        // Restart boundary must capture artifacts.
        await this.captureArtifacts(`restart_${reason}`, snapshot);

        try {
            await this.cleanup();
        } catch {}

        this.browser = null;
        this.context = null;
        this._targetListenerInstalled = false;
        this._patchedPages = null;
        this._blockedMode = null;
        this._blockedClicks = 0;
        this.blockedFirstSeenAt = null;
        this.hasVerifiedChat = false;

        await this.init();

        // Re-warmup and land back on login.
        const snap = await this.warmup();
        return snap;
    }

    async cleanup() {
        if (this.browser) await this.browser.close();
    }
}

function lineForUid(snapshot, uid) {
  if (!snapshot || !uid) return null;
  const re = new RegExp(`uid=${uid}[^\n]*`, 'i');
  const m = snapshot.match(re);
  return m ? m[0] : null;
}

function uidIsDisabled(snapshot, uid) {
  const line = lineForUid(snapshot, uid);
  return !!(line && /\bdisabled\b/i.test(line));
}

function uidIsChecked(snapshot, uid) {
  const line = lineForUid(snapshot, uid);
  if (!line) return false;
  return /\bchecked\b/i.test(line) || /\bselected\b/i.test(line) || /aria-checked="true"/i.test(line);
}

function uidLooksLikeDropdownButton(snapshot, uid) {
  const line = lineForUid(snapshot, uid);
  return !!(
    line &&
    /\bbutton\b/i.test(line) &&
    (/haspopup="listbox"/i.test(line) || /expandable/i.test(line))
  );
}

function findUidMatchingAnyLine(snapshot, labelRegexes, opts = {}) {
  const { excludeUids = [], excludeHaspopup = false } = opts;
  if (!snapshot) return null;
  const lines = snapshot.split('\n');

  for (const line of lines) {
    if (!line.includes('uid=')) continue;
    if (excludeHaspopup && /haspopup="listbox"/i.test(line)) continue;

    const m = line.match(/uid=(\d+_\d+)/i);
    if (!m) continue;
    const uid = m[1];
    if (excludeUids.includes(uid)) continue;

    // Only consider lines that are plausibly clickable/selectable.
    if (!/(\boption\b|\blistitem\b|\bmenuitem\b|\bbutton\b|\bgeneric\b)/i.test(line)) continue;

    for (const re of labelRegexes) {
      if (re.test(line)) return uid;
    }
  }
  return null;
}

function findYearOptionUid(snapshot, opts = {}) {
  const { preferredYear = 1990, maxYear } = opts;
  if (!snapshot) return null;

  const lines = snapshot.split('\n');
  const candidates = [];

  for (const line of lines) {
    if (!line.includes('uid=')) continue;
    if (/haspopup="listbox"/i.test(line)) continue; // skip dropdown button itself

    const uidMatch = line.match(/uid=(\d+_\d+)/i);
    if (!uidMatch) continue;

    // find 4-digit year on the line
    const yearMatch = line.match(/\b(19\d{2}|20\d{2})\b/);
    if (!yearMatch) continue;
    const year = Number(yearMatch[1]);
    if (Number.isNaN(year)) continue;

    // avoid selecting the currently displayed dropdown button label (usually includes "Year" and haspopup)
    if (!/(\boption\b|\blistitem\b|\bmenuitem\b|\bbutton\b|\bgeneric\b)/i.test(line)) continue;

    if (typeof maxYear === 'number' && year > maxYear) continue;

    candidates.push({ uid: uidMatch[1], year, line });
  }

  if (candidates.length === 0) return null;

  // Prefer explicit preferredYear if it exists.
  const exact = candidates.find(c => c.year === preferredYear);
  if (exact) return exact.uid;

  // Otherwise choose the most recent year <= maxYear (closest to maxYear).
  if (typeof maxYear === 'number') {
    candidates.sort((a, b) => b.year - a.year);
    return candidates[0].uid;
  }

  // Fallback: choose the first.
  return candidates[0].uid;
}

export function selectBestPageFromUrls(urls) {
  if (!urls || urls.length === 0) return null;

  // Prefer domains that represent the *current* flow page, not just the original chatgpt.com tab.
  // auth.openai.com is used for OTP/email verification during login.
  const priorities = ['pay.openai.com', 'checkout.stripe.com', 'stripe.com', 'auth.openai.com', 'chatgpt.com'];
  for (const priority of priorities) {
    for (let i = urls.length - 1; i >= 0; i--) {
      const url = urls[i];
      if (url && url !== 'about:blank' && url.includes(priority)) {
        return url;
      }
    }
  }

  for (let i = urls.length - 1; i >= 0; i--) {
    const url = urls[i];
    if (url && url !== 'about:blank') return url;
  }
  return null;
}

export function findChatInputUid(snapshot) {
  const rules = [
    /uid=(\d+_\d+) (?:textbox|textarea|contenteditable).*?(?:message|prompt)/i,
    /uid=(\d+_\d+) paragraph.*?(?:message|prompt)/i,
    /uid=(\d+_\d+) (?:paragraph|generic).*?Ask anything/i,
    /uid=(\d+_\d+) (?:textbox|textarea|contenteditable)/i,
    /uid=(\d+_\d+) .*?role="textbox"/i
  ];

  for (const rule of rules) {
    const match = snapshot.match(rule);
    if (match) return match[1];
  }
  return null;
}

export function detectSplitDobUids(snapshot) {
  if (!snapshot) return null;

  // Be careful: the substring "Day" occurs inside "Birthday".
  // We prefer explicit component labels like "day, Birthday" over a naive .*Day match.
  const day =
    snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox)[^\n]*"Day"/i) ||
    snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox)[^\n]*"day,\s*Birthday"/i) ||
    snapshot.match(/uid=(\d+_\d+) button "[^\"]*(?:\s|^)Day\b/i);

  const month =
    snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox)[^\n]*"Month"/i) ||
    snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox)[^\n]*"month,\s*Birthday"/i) ||
    snapshot.match(/uid=(\d+_\d+) button "[^\"]*(?:\s|^)Month\b/i);

  const year =
    snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox)[^\n]*"Year"/i) ||
    snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox)[^\n]*"year,\s*Birthday"/i) ||
    snapshot.match(/uid=(\d+_\d+) button "[^\"]*(?:\s|^)Year\b/i);

  if (day && month && year) {
    return { day: day[1], month: month[1], year: year[1] };
  }
  return null;
}

export function detectCheckoutProgress(snapshot) {
  if (!snapshot) return { progressed: false, reason: 'no snapshot' };

  const urlMatch = snapshot.match(/RootWebArea[^\n]*url="([^\"]+)"/i);
  const url = urlMatch ? urlMatch[1] : '';

  // Consider Stripe-hosted pages (including pay.openai.com) as still "checkout".
  const isStillCheckout = url ? isStripeCheckoutUrl(url) || url.includes('/checkout') : true;

  // 1) Navigation away from checkout.
  if (url && !isStillCheckout) {
    return { progressed: true, reason: `URL changed away from checkout to ${url}` };
  }

  // 2) Confirmation UI.
  if (
    /Thank you/i.test(snapshot) ||
    /Payment successful/i.test(snapshot) ||
    /Subscription confirmed/i.test(snapshot) ||
    /You(?:'|’)re subscribed/i.test(snapshot)
  ) {
    return { progressed: true, reason: 'Confirmation text found' };
  }

  // 3) Error UI after attempting Subscribe counts as a valid response signal.
  // (We cannot actually complete payment in CI; we just need to ensure the click is not "stuck".)
  if (
    /declined/i.test(snapshot) ||
    /Your card/i.test(snapshot) ||
    /card number/i.test(snapshot) && /invalid|incomplete/i.test(snapshot) ||
    /payment failed/i.test(snapshot) ||
    /There was an error/i.test(snapshot) ||
    /role="alert"/i.test(snapshot)
  ) {
    return { progressed: true, reason: 'Checkout error/alert visible (response detected)' };
  }

  // 4) Button disappeared.
  if (!findSubscribeUid(snapshot)) {
    return { progressed: true, reason: 'Subscribe button disappeared' };
  }

  // 5) Processing indicators.
  if (/Processing|Loading/i.test(snapshot) || /spinner/i.test(snapshot)) {
    return { progressed: false, status: 'processing', reason: 'Processing indicator found' };
  }

  // 6) Button disabled (often happens briefly after click).
  const subscribeUid = findSubscribeUid(snapshot);
  if (subscribeUid && uidIsDisabled(snapshot, subscribeUid)) {
    return { progressed: false, status: 'processing', reason: 'Subscribe button is disabled' };
  }

  return { progressed: false, reason: 'Still on checkout with active Subscribe button' };
}

export function isStripeCheckoutUrl(url) {
  if (!url) return false;
  return (
    url.includes('checkout.stripe.com') ||
    url.includes('stripe.com') ||
    url.includes('pay.openai.com')
  );
}

export function isCheckoutSnapshot(snapshot) {
  if (!snapshot) return false;

  // ChatGPT-hosted checkout pages commonly include the checkout URL and Business trial headings.
  if (snapshot.includes('url="https://chatgpt.com/checkout') || snapshot.includes('stripe.com') || snapshot.includes('pay.openai.com')) return true;

  return (
    /(?:button|link) "Subscribe"/i.test(snapshot) ||
    /Start your free Business trial/i.test(snapshot) ||
    /Purchase ChatGPT Business/i.test(snapshot) ||
    /Offer applied: ChatGPT Business/i.test(snapshot) ||
    /heading "Business plan"/i.test(snapshot) ||
    /heading "Order summary"/i.test(snapshot) ||
    /heading "Payment method"/i.test(snapshot)
  );
}

export function findCheckoutEmailUid(snapshot) {
  if (!snapshot) return null;
  const match = snapshot.match(/uid=(\d+_\d+) textbox "Email"/i) ||
                snapshot.match(/uid=(\d+_\d+) textbox "Email address"/i) ||
                snapshot.match(/uid=(\d+_\d+) textbox[^\n]*\bemail\b/i);
  return match ? match[1] : null;
}

export function findCheckoutSeatsUid(snapshot) {
  if (!snapshot) return null;
  const match = snapshot.match(/uid=(\d+_\d+) spinbutton.*valuetext=/i) ||
                snapshot.match(/uid=(\d+_\d+) spinbutton.*"Number of seats"/i);
  return match ? match[1] : null;
}

// Stripe-hosted checkout (pay.openai.com) can expose payment/billing inputs directly as textboxes
// in the snapshot tree (no iframes). Prefer these helpers before iframe-only logic.
export function findCheckoutCardNumberUid(snapshot) {
  if (!snapshot) return null;
  const m = snapshot.match(/uid=(\d+_\d+) textbox "Card number"/i);
  return m ? m[1] : null;
}

export function findCheckoutCardExpiryUid(snapshot) {
  if (!snapshot) return null;
  const m =
    snapshot.match(/uid=(\d+_\d+) textbox "Expiration"/i) ||
    snapshot.match(/uid=(\d+_\d+) textbox "Expiry"/i);
  return m ? m[1] : null;
}

export function findCheckoutCardCvcUid(snapshot) {
  if (!snapshot) return null;
  const m =
    snapshot.match(/uid=(\d+_\d+) textbox "CVC"/i) ||
    snapshot.match(/uid=(\d+_\d+) textbox "Security code"/i);
  return m ? m[1] : null;
}

export function findCheckoutCardholderNameUid(snapshot) {
  if (!snapshot) return null;
  const m = snapshot.match(/uid=(\d+_\d+) textbox "Cardholder name"/i);
  return m ? m[1] : null;
}

export function findEnterAddressManuallyUid(snapshot) {
  if (!snapshot) return null;
  const m = snapshot.match(/uid=(\d+_\d+) button "Enter address manually"/i);
  return m ? m[1] : null;
}

export function findCheckoutTermsCheckboxUid(snapshot) {
  if (!snapshot) return null;
  const m =
    snapshot.match(/uid=(\d+_\d+) checkbox "You'll be charged[^\n]*"/i) ||
    snapshot.match(/uid=(\d+_\d+) checkbox "[^"]*(?:agree|Business Terms|charged monthly)[^"]*"/i);
  return m ? m[1] : null;
}

export function findPricingTryCtaUid(snapshot) {
  if (!snapshot) return null;

  // Prefer explicit labeled CTA.
  // NOTE: Do NOT match the in-chat "Free offer" pill here. That button can exist even when the pricing UI
  // is not actually rendered (e.g. url hash is #pricing but the SPA stayed on the chat home).
  const labeled =
    snapshot.match(/uid=(\d+_\d+) (?:button|link) "Try for [^"]+"/i) ||
    snapshot.match(/uid=(\d+_\d+) (?:button|link) "Try for free"/i) ||
    snapshot.match(/uid=(\d+_\d+) (?:button|link) "Try Business free"/i) ||
    snapshot.match(/uid=(\d+_\d+) (?:button|link) "Try Business"/i) ||
    snapshot.match(/uid=(\d+_\d+) (?:button|link) "Upgrade to Business"/i) ||
    snapshot.match(/uid=(\d+_\d+) (?:button|link) "Upgrade to Team"/i) ||
    snapshot.match(/uid=(\d+_\d+) (?:button|link) "Upgrade to [^"]*Business[^"]*"/i) ||
    snapshot.match(/uid=(\d+_\d+) (?:button|link) "Upgrade to [^"]*Team[^"]*"/i);
  if (labeled) return labeled[1];

  // Fallback: unlabeled primary CTA is often the first button following the main Business trial heading.
  const lines = snapshot.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/heading "Try Business free for 1 month"/i.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      const line = lines[j];
      const m = line.match(/uid=(\d+_\d+) button\b(?!.*\")/i) || line.match(/uid=(\d+_\d+) button\b/i);
      if (!m) continue;
      // Avoid obvious non-CTA buttons.
      if (/Your current plan|Close|Dismiss/i.test(line)) continue;
      return m[1];
    }
  }

  return null;
}

export function findSubscribeUid(snapshot) {
  if (!snapshot) return null;
  const match = snapshot.match(/uid=(\d+_\d+) button "Subscribe"/i) ||
                snapshot.match(/uid=(\d+_\d+) button "Start trial"/i) ||
                snapshot.match(/uid=(\d+_\d+) button "Pay"/i) ||
                snapshot.match(/uid=(\d+_\d+) button "Continue"/i);
  return match ? match[1] : null;
}

export function findCheckoutPaymentFrameUid(snapshot) {
  if (!snapshot) return null;
  const lines = snapshot.split('\n');
  let inPayment = false;
  let inBilling = false;
  for (const line of lines) {
    if (line.includes('heading "Payment method"')) {
      inPayment = true;
      inBilling = false;
      continue;
    }
    if (line.includes('heading "Billing address"')) {
      inBilling = true;
      inPayment = false;
      continue;
    }
    if (!line.includes('IframePresentational')) continue;
    if (inPayment) {
      const match = line.match(/uid=(\d+_\d+)/i);
      if (match) return match[1];
    }
  }
  return null;
}

export function findCheckoutBillingFrameUid(snapshot) {
  if (!snapshot) return null;
  const lines = snapshot.split('\n');
  let inPayment = false;
  let inBilling = false;
  for (const line of lines) {
    if (line.includes('heading "Payment method"')) {
      inPayment = true;
      inBilling = false;
      continue;
    }
    if (line.includes('heading "Billing address"')) {
      inBilling = true;
      inPayment = false;
      continue;
    }
    if (!line.includes('IframePresentational')) continue;
    if (inBilling) {
      const match = line.match(/uid=(\d+_\d+)/i);
      if (match) return match[1];
    }
  }
  return null;
}
