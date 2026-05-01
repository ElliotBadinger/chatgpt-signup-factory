import { SignupFactory } from './src/SignupFactory.js';
import fs from 'node:fs';

async function test() {
    const API_KEY = process.env.AGENTMAIL_API_KEY;
    const factory = new SignupFactory(API_KEY, { headless: true });
    await factory.init();
    await factory.callTool('navigate_page', { url: 'https://chatgpt.com/' });
    await new Promise(r => setTimeout(r, 5000));
    const snapshot = await factory.getSnapshot();
    fs.writeFileSync('test_snapshot.txt', snapshot);
    await factory.callTool('take_screenshot', { filePath: 'test_screenshot.png' });
    await factory.cleanup();
}
test();
