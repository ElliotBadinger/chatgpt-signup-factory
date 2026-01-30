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
global.navigator = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' };
global.window = { 
    location: { pathname: '/' },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64')
};
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
        this.lastHandledState = null;
        this.stateAttempts = 0;
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
        const inbox = await this.emailProvider.createInbox();
        this.email = inbox.inbox_id;
        console.log('Target Email:', this.email);

        await this.callTool('navigate_page', { url: 'https://chatgpt.com/auth/login' });
        
        let attempts = 0;
        while (attempts < 50) {
            attempts++;
            const snapshot = await this.getSnapshot();
            fs.writeFileSync('debug_snapshot.txt', snapshot);
            const state = this.stateManager.detectState(snapshot);
            console.log(`[Step ${attempts}] State: ${state}`);

            if (state === 'CHAT_INTERFACE') {
                console.log('!!! SUCCESS: Reach ChatGPT !!!');
                // Verification: talk to it
                await this.verifyAccount(snapshot);
                return true;
            }

            if (state === this.lastHandledState) {
                this.stateAttempts++;
            } else {
                this.lastHandledState = state;
                this.stateAttempts = 0;
            }

            // Only retry logic if we've been stuck in a state for a while
            if (this.stateAttempts % 3 === 0) {
                try {
                    await this.handleState(state, snapshot);
                } catch (e) {
                    console.error('Error handling state:', e.message);
                }
            }
            await new Promise(r => setTimeout(r, 5000));
        }
        throw new Error('Automation timed out or stuck');
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
                const code = await this.emailProvider.waitForCode(this.email, 10000);
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
                const nameInp = snapshot.match(/uid=(\d+_\d+) textbox "Full name"/);
                const dayInp = snapshot.match(/uid=(\d+_\d+) spinbutton "day/);
                const monthInp = snapshot.match(/uid=(\d+_\d+) spinbutton "month/);
                const yearInp = snapshot.match(/uid=(\d+_\d+) spinbutton "year/);
                
                if (nameInp) {
                    await this.callTool('click', { uid: nameInp[1] });
                    await this.callTool('fill', { uid: nameInp[1], value: 'Agent' });
                }
                if (dayInp) {
                    await this.callTool('click', { uid: dayInp[1] });
                    await this.callTool('fill', { uid: dayInp[1], value: '01' });
                }
                if (monthInp) {
                    await this.callTool('click', { uid: monthInp[1] });
                    await this.callTool('fill', { uid: monthInp[1], value: '01' });
                }
                if (yearInp) {
                    await this.callTool('click', { uid: yearInp[1] });
                    await this.callTool('fill', { uid: yearInp[1], value: '1990' });
                }

                await new Promise(r => setTimeout(r, 2000));
                const contBtn = snapshot.match(/uid=(\d+_\d+) button "Continue"/);
                if (contBtn) await this.callTool('click', { uid: contBtn[1] });
                break;
            case 'ONBOARDING':
                const skip = snapshot.match(/uid=(\d+_\d+) button "(?:Skip|Next|Continue|Okay, let’s go)"/);
                if (skip) await this.callTool('click', { uid: skip[1] });
                break;
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
        }
    }

    async cleanup() {
        if (this.browser) await this.browser.close();
    }
}
