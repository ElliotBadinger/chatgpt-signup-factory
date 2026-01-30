import { ensureBrowserLaunched } from '../chrome-devtools-mcp/build/src/browser.js';
import { tools } from '../chrome-devtools-mcp/build/src/tools/tools.js';
import { McpContext } from '../chrome-devtools-mcp/build/src/McpContext.js';
import { McpResponse } from '../chrome-devtools-mcp/build/src/McpResponse.js';
import { logger } from '../chrome-devtools-mcp/build/src/logger.js';
import { loadIssueDescriptions } from '../chrome-devtools-mcp/build/src/issue-descriptions.js';
import { AgentMailProvider } from './AgentMailProvider.js';
import { ChatGPTStateManager } from './ChatGPTStateManager.js';
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
    constructor(agentMailApiKey) {
        this.emailProvider = new AgentMailProvider(agentMailApiKey);
        this.stateManager = new ChatGPTStateManager();
        this.browser = null;
        this.context = null;
        this.email = null;
        this.password = 'AutomationTest123!';
    }

    async init() {
        await loadIssueDescriptions();
        this.browser = await ensureBrowserLaunched({
            headless: false,
            channel: 'stable',
            userDataDir: PROFILE_DIR,
            chromeArgs: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
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
        const targetPage = pages.find(p => p.url() !== 'about:blank') || pages[pages.length-1];
        if (targetPage) await this.context.selectPage(targetPage);
        const res = await response.handle(name, this.context);
        if (!res || !res.content) return [{ type: 'text', text: '' }];
        console.log(`>> [${name}] response: ${res.content[0].text.substring(0, 50)}...`);
        return res.content;
    }

    async getSnapshot() {
        const resp = await this.callTool('take_snapshot', { verbose: true });
        if (!resp || resp.length === 0) return "";
        return resp[0].text || "";
    }

    async run() {
        console.log('--- SIGNUP FACTORY START ---');
        
        await this.callTool('navigate_page', { url: 'https://chatgpt.com/' });
        await new Promise(r => setTimeout(r, 5000));
        
        let snapshot = await this.getSnapshot();
        let state = this.stateManager.detectState(snapshot);
        
        if (state === 'CHAT_INTERFACE') {
            console.log('Detected existing session. Proceeding to verification.');
        } else {
            console.log('No existing session or blocked. Starting signup flow.');
            const inbox = await this.emailProvider.createInbox();
            this.email = inbox.inbox_id;
            console.log('Target Email:', this.email);
            await this.callTool('navigate_page', { url: 'https://chatgpt.com/auth/login' });
        }
        
        let attempts = 0;
        let lastState = null;
        let stateCounter = 0;

        while (attempts < 50) {
            attempts++;
            const snapshot = await this.getSnapshot();
            fs.writeFileSync('debug_snapshot.txt', snapshot);
            const state = this.stateManager.detectState(snapshot);
            console.log(`[Step ${attempts}] State: ${state}`);

            if (state === 'CHAT_INTERFACE') {
                console.log('!!! SUCCESS: Reach ChatGPT !!!');
                await this.verifyAccount(snapshot);
                return true;
            }

            if (state === lastState && state !== 'UNKNOWN') {
                stateCounter++;
            } else {
                lastState = state;
                stateCounter = 1;
            }

            // Delta strategy: if stuck for 3 snapshots, try something else
            // Mandate: "stays in the same state for more than 3 consecutive snapshots without a successful action"
            // We'll try to act in every step. If stateCounter reaches 4, it means 3 actions failed to change state.
            if (stateCounter === 2) {
                console.log(`[Step ${attempts}] STUCK in ${state} for 2 steps. Trying Delta: Escape`);
                await this.callTool('press_key', { key: 'Escape' });
            } else if (stateCounter === 3) {
                console.log(`[Step ${attempts}] STUCK in ${state} for 3 steps. Trying Delta: Refresh (F5)`);
                await this.callTool('press_key', { key: 'F5' });
            } else if (stateCounter > 3) {
                const dump = {
                    state,
                    attempts,
                    snapshot: snapshot
                };
                const dumpStr = JSON.stringify(dump, null, 2);
                fs.writeFileSync('STUCK_STATE_DUMP.json', dumpStr);
                console.error('STUCK_STATE detected. Dumping accessibility tree:');
                console.error(dumpStr);
                throw new Error(`STUCK_STATE: ${state} for ${stateCounter} steps`);
            } else {
                // Normal handling
                try {
                    const acted = await this.handleState(state, snapshot);
                    if (acted) {
                        // We reset or decrement counter if we think we did something? 
                        // Actually, if we acted and state remains same, we are still potentially stuck.
                        // But some states like ONBOARDING have multiple screens.
                    }
                } catch (e) {
                    console.error('Error handling state:', e.message);
                }
            }

            await new Promise(r => setTimeout(r, 5000));
        }
        throw new Error('Automation timed out');
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
                const code = await this.emailProvider.waitForCode(this.email, 60000);
                if (code) {
                    const codeInput = snapshot.match(/uid=(\d+_\d+) textbox "Code"/i);
                    if (codeInput) {
                        await this.fillField(codeInput[1], code);
                        await this.callTool('press_key', { key: 'Enter' });
                        acted = true;
                    }
                }
                break;
            case 'ABOUT_YOU':
                console.log('Handling ABOUT_YOU...');
                const nameInp = snapshot.match(/uid=(\d+_\d+) (?:textbox|textarea) "Full name"/i);
                const birthdayFields = snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox).*?"month/i);
                
                if (nameInp) {
                    await this.fillField(nameInp[1], 'Agent User');
                    acted = true;
                }
                
                const monthInp = snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox).*?"month/i);
                const dayInp = snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox).*?"day/i);
                const yearInp = snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox).*?"year/i);
                const birthdayInp = snapshot.match(/uid=(\d+_\d+) (?:textbox|textarea) "Birthday"/i);

                if (birthdayInp) {
                    await this.fillField(birthdayInp[1], '01/01/1990');
                    acted = true;
                } else if (monthInp || dayInp || yearInp) {
                    if (monthInp) await this.fillField(monthInp[1], '1');
                    if (dayInp) await this.fillField(dayInp[1], '1');
                    if (yearInp) await this.fillField(yearInp[1], '1990');
                    acted = true;
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
                throw new Error('ACCESS_DENIED_IP_BLOCKED');
        }
        return acted;
    }

    async verifyAccount(snapshot) {
        console.log('Sending final verification message...');
        const inputMatch = snapshot.match(/uid=(\d+_\d+) (?:textbox|textarea|paragraph).*?prompt/i) || 
                           snapshot.match(/uid=(\d+_\d+) (?:textbox|textarea|paragraph).*?message/i) ||
                           snapshot.match(/uid=(\d+_\d+) paragraph[\s\S]*?Ask anything/i);
        if (inputMatch) {
            const uid = inputMatch[1];
            await this.callTool('click', { uid });
            await this.callTool('fill', { uid, value: 'Please respond with exactly: SUCCESS_AGENT_VERIFIED' });
            await this.callTool('press_key', { key: 'Enter' });
            await new Promise(r => setTimeout(r, 15000));
            const result = await this.getSnapshot();
            console.log('--- CHATGPT VERIFICATION RESPONSE ---');
            console.log(result);
            if (result.includes('SUCCESS_AGENT_VERIFIED')) {
                console.log('--- VERIFICATION SUCCESS ---');
            } else {
                console.warn('--- VERIFICATION FAILED: Handshake not found in response ---');
            }
        }
    }

    async cleanup() {
        if (this.browser) await this.browser.close();
    }
}
