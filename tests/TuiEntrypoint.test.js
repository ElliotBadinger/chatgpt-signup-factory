import React from 'react';
import {render} from 'ink-testing-library';
import App from '../src/tui/App.js';
import { runTui } from '../src/tui/entrypoint.js';

describe('TUI App', () => {
	it('renders the wizard as the initial screen', () => {
		const {lastFrame} = render(React.createElement(App));
		expect(lastFrame()).toContain('Config Wizard');
	});

	it('exposes runTui with configPath support', () => {
		expect(typeof runTui).toBe('function');
	});

	it('shows vault prompt when persistSecrets is enabled', async () => {
		const { lastFrame, stdin } = render(
			React.createElement(App, {
				isActive: true,
				initialConfig: { safety: { persistSecrets: true } }
			})
		);

		if (!stdin.ref) stdin.ref = () => {};
		if (!stdin.unref) stdin.unref = () => {};

		let sent = false;
		stdin.read = () => {
			if (sent) return null;
			sent = true;
			return Buffer.from('\r');
		};
		await new Promise(resolve => setImmediate(resolve));
		stdin.emit('readable');
		await new Promise(resolve => setImmediate(resolve));
		expect(lastFrame()).toContain('Vault Passcode');
	});
});
