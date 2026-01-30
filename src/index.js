#!/usr/bin/env node
import { SignupFactory } from './SignupFactory.js';

const API_KEY = process.env.AGENTMAIL_API_KEY;
if (!API_KEY) {
    console.error('ERROR: AGENTMAIL_API_KEY environment variable is required.');
    process.exit(1);
}

async function main() {
    const factory = new SignupFactory(API_KEY);
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
}

main();
