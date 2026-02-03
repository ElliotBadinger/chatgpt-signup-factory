#!/usr/bin/env node
import { SignupFactory } from './SignupFactory.js';
import { AgentMailProvider } from './AgentMailProvider.js';
import { EmailProvisioner } from './EmailProvisioner.js';
import { getRunConfig } from './RunConfig.js';

const API_KEY = process.env.AGENTMAIL_API_KEY;
if (!API_KEY) {
    console.error('ERROR: AGENTMAIL_API_KEY environment variable is required.');
    process.exit(1);
}

async function main() {
    const runConfig = getRunConfig();
    const agentMailProvider = new AgentMailProvider(API_KEY);
    const provisioner = new EmailProvisioner({ agentMailProvider, env: process.env });

    let email = process.env.SIGNUP_EMAIL || null;
    let agentMailInbox = process.env.AGENTMAIL_INBOX || null;
    let provisioned = null;

    try {
        if (!email) {
            provisioned = await provisioner.provision();
            email = provisioned.address;
            agentMailInbox = provisioned.inboxId;
        }

        const factory = new SignupFactory(API_KEY, {
            email,
            agentMailInbox,
            runConfig
        });

        try {
            await factory.init();
            await factory.run();
            console.log('SUCCESS: ChatGPT account provisioned and ready.');
            process.exit(0);
        } catch (err) {
            console.error('FATAL ERROR:', err);
            process.exit(1);
        } finally {
            await factory.cleanup();
        }
    } finally {
        if (provisioned) {
            await provisioner.cleanup();
        }
    }
}

main();
