#!/usr/bin/env node
import { SignupFactory } from './SignupFactory.js';

const API_KEY = process.env.AGENTMAIL_API_KEY || 'am_a0c98e7c5c2a1bf80fbac1685eae5e5afa76851342bc36607d1a3c664318f2c4';

async function main() {
    const factory = new SignupFactory(API_KEY);
    try {
        await factory.init();
        await factory.run();
        console.log('SUCCESS: ChatGPT account provisioned and ready.');
    } catch (err) {
        console.error('FATAL ERROR:', err);
        process.exit(1);
    } finally {
        // Keep browser open if needed for inspection or cleanup
        // await factory.cleanup(); 
    }
}

main();
