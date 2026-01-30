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
            console.log('No existing session. Starting signup flow.');
            const inbox = await this.emailProvider.createInbox();
            this.email = inbox.inbox_id;
            console.log('Target Email:', this.email);
            await this.callTool('navigate_page', { url: 'https://chatgpt.com/auth/login' });
        }
        
        let attempts = 0;
        let lastState = null;
        let stateCounter = 0;
        let lastFullSnapshot = "";

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

            // Delta strategy: if stuck for 2 snapshots, try something else
            if (stateCounter === 2) {
                console.log(`[Step ${attempts}] STUCK in ${state} for 2 steps. Trying Delta: Escape`);
                await this.callTool('press_key', { key: 'Escape' });
            } else if (stateCounter === 3) {
                console.log(`[Step ${attempts}] STUCK in ${state} for 3 steps. Trying Delta: Refresh`);
                await this.callTool('evaluate_script', { function: '() => { location.reload(); }' });
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
                    await this.handleState(state, snapshot);
                } catch (e) {
                    console.error('Error handling state:', e.message);
                }
            }

            await new Promise(r => setTimeout(r, 5000));
        }
        throw new Error('Automation timed out');
    }

    async handleState(state, snapshot) {
        switch (state) {
            case 'LANDING':
                const signupBtn = snapshot.match(/uid=(\d+_\d+) button "Sign up for free"/);
                if (signupBtn) await this.callTool('click', { uid: signupBtn[1] });
                break;
            case 'LOGIN_EMAIL':
                const emailInput = snapshot.match(/uid=(\d+_\d+) textbox "Email address"/);
                if (emailInput) {
                    await this.callTool('fill', { uid: emailInput[1], value: this.email });
                    await new Promise(r => setTimeout(r, 1000));
                    const continueBtn = snapshot.match(/uid=(\d+_\d+) button "Continue"/);
                    if (continueBtn) await this.callTool('click', { uid: continueBtn[1] });
                    else await this.callTool('press_key', { key: 'Enter' });
                }
                break;
            case 'LOGIN_PASSWORD':
                const passInput = snapshot.match(/uid=(\d+_\d+) textbox "Password"/);
                if (passInput) {
                    await this.callTool('fill', { uid: passInput[1], value: this.password });
                    await new Promise(r => setTimeout(r, 1000));
                    const continueBtn = snapshot.match(/uid=(\d+_\d+) button "Continue"/);
                    if (continueBtn) await this.callTool('click', { uid: continueBtn[1] });
                    else await this.callTool('press_key', { key: 'Enter' });
                }
                break;
            case 'OTP_VERIFICATION':
                const code = await this.emailProvider.waitForCode(this.email, 60000);
                if (code) {
                    const codeInput = snapshot.match(/uid=(\d+_\d+) textbox "Code"/);
                    if (codeInput) {
                        await this.callTool('click', { uid: codeInput[1] });
                        await this.callTool('fill', { uid: codeInput[1], value: code });
                        await this.callTool('press_key', { key: 'Enter' });
                    }
                }
                break;
            case 'ABOUT_YOU':
                console.log('Handling ABOUT_YOU...');
                const nameInp = snapshot.match(/uid=(\d+_\d+) (?:textbox|textarea) "Full name"/i);
                const dayInp = snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox) "day/i);
                const monthInp = snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox) "month/i);
                const yearInp = snapshot.match(/uid=(\d+_\d+) (?:spinbutton|textbox) "year/i);
                const birthdayInp = snapshot.match(/uid=(\d+_\d+) (?:textbox|textarea) "Birthday"/i);
                
                if (nameInp) {
                    await this.callTool('fill', { uid: nameInp[1], value: 'Agent User' });
                    await new Promise(r => setTimeout(r, 500));
                }
                if (birthdayInp) {
                    await this.callTool('fill', { uid: birthdayInp[1], value: '01/01/1990' });
                } else {
                    if (dayInp) await this.callTool('fill', { uid: dayInp[1], value: '01' });
                    if (monthInp) await this.callTool('fill', { uid: monthInp[1], value: '01' });
                    if (yearInp) await this.callTool('fill', { uid: yearInp[1], value: '1990' });
                }

                await new Promise(r => setTimeout(r, 2000));
                const contBtn = snapshot.match(/uid=(\d+_\d+) button "(?:Continue|Submit|Done)"/i);
                if (contBtn) {
                    await this.callTool('click', { uid: contBtn[1] });
                } else {
                    await this.callTool('press_key', { key: 'Enter' });
                }
                break;
            case 'ONBOARDING':
                const skip = snapshot.match(/uid=(\d+_\d+) button "(?:Skip|Next|Continue|Okay, let’s go)"/i);
                if (skip) await this.callTool('click', { uid: skip[1] });
                break;
            case 'BLOCKED':
                console.log('Handling BLOCKED/Turnstile...');
                const check = snapshot.match(/uid=(\d+_\d+) checkbox/i) || snapshot.match(/uid=(\d+_\d+) button "Verify you are human"/i);
                if (check) {
                    await this.callTool('click', { uid: check[1] });
                }
                break;
            case 'ACCESS_DENIED':
                throw new Error('ACCESS_DENIED_IP_BLOCKED');
        }
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
