import { ensureBrowserLaunched } from '../chrome-devtools-mcp/build/src/browser.js';
import { tools } from '../chrome-devtools-mcp/build/src/tools/tools.js';
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

// Polyfills for browser environment
Object.defineProperty(global, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
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
    }

    async init() {
        await loadIssueDescriptions();
        this.browser = await ensureBrowserLaunched({
            headless: this.headless,
            channel: 'stable',
            userDataDir: this.userDataDir,
            chromeArgs: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,1024'],
        });
        this.context = await McpContext.from(this.browser, logger, {});
    }

    async callTool(name, params = {}) {
        console.log(`>> [${name}] calling with ${JSON.stringify(params)}`);
        const tool = tools.find(t => t.name === name);
        if (!tool) throw new Error(`Tool ${name} not found`);
        const response = new McpResponse();
        if (params.uid) await this.context.createTextSnapshot(false);
        try {
            await tool.handler({ params }, response, this.context);
        } catch (e) {
            console.error(`[Tool ${name}] Execution error:`, e.message);
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

    async run() {
        console.log('--- SIGNUP FACTORY START ---');

        this.startTime = Date.now();

        await this.callTool('navigate_page', { url: 'https://chatgpt.com/' });
        await new Promise(r => setTimeout(r, 2000));

        let snapshot = await this.getSnapshot();
        let state = this.stateManager.detectState(snapshot);

        if (state === 'CHAT_INTERFACE') {
            console.log('Detected existing session. Proceeding to verification.');
        } else {
            console.log('No existing session or blocked. Starting signup flow.');
            if (!this.email) {
                const inbox = await this.emailProvider.createInbox();
                this.email = inbox.inbox_id;
                this.agentMailInbox = inbox.inbox_id;
            }
            console.log('Target Email:', this.email);
            await this.callTool('navigate_page', { url: 'https://chatgpt.com/auth/login' });
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
            fs.writeFileSync('debug_snapshot.txt', snapshot);
            state = this.stateManager.detectState(snapshot);
            console.log(`[Step ${attempts}] State: ${state}`);

            if (state === 'CHAT_INTERFACE') {
                console.log('!!! SUCCESS: Reach ChatGPT !!!');
                await this.verifyAccount(snapshot);
                return true;
            }

            if (state === lastState) {
                stateCounter++;
            } else {
                lastState = state;
                stateCounter = 1;
                stateStartTime = Date.now();
            }

            if (Date.now() - stateStartTime > this.runConfig.STEP_TIMEOUT_MS) {
                await this.failWithDebug(`STEP_TIMEOUT: ${state}`, snapshot);
            }

            if (stateCounter > this.runConfig.STATE_STUCK_LIMIT) {
                await this.failWithDebug(`STUCK_STATE: ${state}`, snapshot);
            }

            try {
                await this.handleState(state, snapshot);
            } catch (e) {
                await this.failWithDebug(`STATE_ERROR: ${state} - ${e.message}`, snapshot);
            }

            await new Promise(r => setTimeout(r, 1000));
        }
        throw new Error('Automation timed out');
    }

    async failWithDebug(reason, snapshot) {
        console.error(`!!! CRITICAL FAILURE: ${reason} !!!`);
        if (snapshot) {
            fs.writeFileSync('failure_snap.txt', snapshot);
        }
        try {
            await this.callTool('take_screenshot', { filePath: 'failure_screenshot.png' });
        } catch (e) {
            console.error('Failed to capture screenshot:', e.message);
        }
        throw new Error(reason);
    }

    async fillField(uid, value) {
        await this.callTool('click', { uid });
        await new Promise(r => setTimeout(r, 200));
        await this.callTool('fill', { uid, value });
        await new Promise(r => setTimeout(r, 200));
    }

    async handleState(state, snapshot) {
        let acted = false;
        switch (state) {
            case 'LANDING':
                const signupBtn = snapshot.match(/uid=(\d+_\d+) button "Sign up for free"/i);
                if (signupBtn) {
                    await this.callTool('click', { uid: signupBtn[1] });
                    acted = true;
                }
                break;
            case 'LOGIN_EMAIL':
                const emailInput = snapshot.match(/uid=(\d+_\d+) textbox "Email address"/i);
                if (emailInput) {
                    await this.fillField(emailInput[1], this.email);
                    const continueBtn = snapshot.match(/uid=(\d+_\d+) button "Continue"/i);
                    if (continueBtn) await this.callTool('click', { uid: continueBtn[1] });
                    else await this.callTool('press_key', { key: 'Enter' });
                    acted = true;
                }
                break;
            case 'LOGIN_PASSWORD':
                const passInput = snapshot.match(/uid=(\d+_\d+) textbox "Password"/i);
                if (passInput) {
                    await this.fillField(passInput[1], this.password);
                    const continueBtn = snapshot.match(/uid=(\d+_\d+) button "Continue"/i);
                    if (continueBtn) await this.callTool('click', { uid: continueBtn[1] });
                    else await this.callTool('press_key', { key: 'Enter' });
                    acted = true;
                }
                break;
            case 'OTP_VERIFICATION':
                const code = await this.emailProvider.waitForCode(this.agentMailInbox || this.email, this.runConfig.OTP_TIMEOUT_MS);
                if (!code) {
                    throw new Error('OTP_TIMEOUT');
                }
                const codeInput = snapshot.match(/uid=(\d+_\d+) textbox "Code"/i);
                if (codeInput) {
                    await this.fillField(codeInput[1], code);
                    await this.callTool('press_key', { key: 'Enter' });
                    acted = true;
                }
                break;
            case 'ABOUT_YOU':
                console.log('Handling ABOUT_YOU...');
                const nameInp = snapshot.match(/uid=(\d+_\d+) (?:textbox|textarea) "Full name"/i);
                
                if (nameInp) {
                    await this.fillField(nameInp[1], 'Agent User');
                    acted = true;
                }
                
                const splitDob = detectSplitDobUids(snapshot);
                if (splitDob) {
                    await this.fillField(splitDob.day, '01');
                    await this.fillField(splitDob.month, '01');
                    await this.fillField(splitDob.year, '1990');
                    acted = true;
                } else {
                    const birthdayInp = snapshot.match(/uid=(\d+_\d+) (?:textbox|textarea) "Birthday"/i);
                    if (birthdayInp) {
                        await this.fillField(birthdayInp[1], '01/01/1990');
                        acted = true;
                    }
                }

                if (acted) {
                    await new Promise(r => setTimeout(r, 1000));
                    const contBtn = snapshot.match(/uid=(\d+_\d+) button "(?:Continue|Submit|Done)"/i);
                    if (contBtn) {
                        await this.callTool('click', { uid: contBtn[1] });
                    } else {
                        await this.callTool('press_key', { key: 'Enter' });
                    }
                }
                break;
            case 'ONBOARDING':
                const skipBtn = snapshot.match(/uid=(\d+_\d+) button "Skip"/i);
                if (skipBtn) {
                    await this.callTool('click', { uid: skipBtn[1] });
                    acted = true;
                } else {
                    const nextBtn = snapshot.match(/uid=(\d+_\d+) button "(?:Next|Continue|Okay, let’s go|Yes|Stay logged in|Done)"/i);
                    if (nextBtn) {
                        await this.callTool('click', { uid: nextBtn[1] });
                        acted = true;
                    }
                }
                break;
            case 'BLOCKED':
                console.log('Handling BLOCKED/Turnstile...');
                const check = snapshot.match(/uid=(\d+_\d+) checkbox/i) || snapshot.match(/uid=(\d+_\d+) button "Verify you are human"/i);
                if (check) {
                    await this.callTool('click', { uid: check[1] });
                    acted = true;
                }
                break;
            case 'ACCESS_DENIED':
                await this.failWithDebug('ACCESS_DENIED', snapshot);
                break;
        }
        return acted;
    }

    async verifyAccount(snapshot) {
        console.log('Sending final verification message...');
        let currentSnapshot = snapshot;
        
        for (let attempt = 1; attempt <= 3; attempt++) {
            const uid = findChatInputUid(currentSnapshot);
            if (uid) {
                await this.callTool('click', { uid });
                await this.callTool('fill', { uid, value: 'Please respond with exactly: SUCCESS_AGENT_VERIFIED' });
                await this.callTool('press_key', { key: 'Enter' });
                await new Promise(r => setTimeout(r, 15000));
                
                const result = await this.getSnapshot();
                console.log('--- CHATGPT VERIFICATION RESPONSE ---');
                console.log(result);
                
                if (result.includes('SUCCESS_AGENT_VERIFIED')) {
                    console.log('--- VERIFICATION SUCCESS ---');
                    return;
                }
            }
            
            if (attempt < 3) {
                console.warn(`Attempt ${attempt} failed to verify. Retrying...`);
                await new Promise(r => setTimeout(r, 2000));
                currentSnapshot = await this.getSnapshot();
            }
        }
        console.warn('--- VERIFICATION FAILED: Handshake not found in response after 3 attempts ---');
    }

    async cleanup() {
        if (this.browser) await this.browser.close();
    }
}

export function selectBestPageFromUrls(urls) {
  if (!urls || urls.length === 0) return null;

  const priorities = ['checkout.stripe.com', 'stripe.com', 'chatgpt.com'];
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
  const day = snapshot.match(/uid=(\d+_\d+) spinbutton "Day"/i);
  const month = snapshot.match(/uid=(\d+_\d+) spinbutton "Month"/i);
  const year = snapshot.match(/uid=(\d+_\d+) spinbutton "Year"/i);
  if (day && month && year) {
    return { day: day[1], month: month[1], year: year[1] };
  }
  return null;
}
