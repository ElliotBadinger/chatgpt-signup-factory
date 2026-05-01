import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import App from '../src/tui/App.js';
import { Events } from '../src/orchestrator/events.js';
import { validateConfig } from '../src/config/manager.js';
import { createInkTestHarness } from './helpers/inkHarness.js';

async function waitForText(harness, text, timeoutMs = 1000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if ((harness.lastFrame() || '').includes(text)) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`Timed out waiting for text: ${text}`);
}

class FakeOrchestrator extends EventEmitter {
	async run() {
		this.emit(Events.RUN_START, { type: Events.RUN_START, timestamp: Date.now() });
		this.emit(Events.STATE_CHANGE, { type: Events.STATE_CHANGE, state: 'LOGIN_EMAIL', attempts: 1, timestamp: Date.now() });
		this.emit(Events.STATE_CHANGE, { type: Events.STATE_CHANGE, state: 'OTP_VERIFICATION', attempts: 2, timestamp: Date.now() });
		this.emit(Events.STATE_CHANGE, { type: Events.STATE_CHANGE, state: 'CHECKOUT', attempts: 3, timestamp: Date.now() });
		this.emit(Events.RUN_SUCCESS, { type: Events.RUN_SUCCESS, timestamp: Date.now() });
		return true;
	}
}

class CheckpointOrchestrator extends EventEmitter {
	constructor({ checkpointProvider }) {
		super();
		this.checkpointProvider = checkpointProvider;
	}

	async run() {
		this.emit(Events.RUN_START, { type: Events.RUN_START, timestamp: Date.now() });
		this.emit(Events.STATE_CHANGE, { type: Events.STATE_CHANGE, state: 'CHECKOUT', attempts: 1, timestamp: Date.now() });

		this.emit(Events.CHECKPOINT_BEFORE_SUBSCRIBE, {
			type: Events.CHECKPOINT_BEFORE_SUBSCRIBE,
			message: 'Proceed to Stripe subscribe click',
			timestamp: Date.now(),
		});

		const approved = await this.checkpointProvider.approve({
			message: 'Proceed to Stripe subscribe click',
		});

		if (!approved) {
			this.emit(Events.RUN_FAILURE, { type: Events.RUN_FAILURE, error: 'CHECKPOINT_REJECTED', timestamp: Date.now() });
			throw new Error('CHECKPOINT_REJECTED');
		}

		this.emit(Events.RUN_SUCCESS, { type: Events.RUN_SUCCESS, timestamp: Date.now() });
		return true;
	}
}

class FailingOrchestrator extends EventEmitter {
	async run() {
		this.emit(Events.RUN_START, { type: Events.RUN_START, timestamp: Date.now() });
		this.emit(Events.STATE_CHANGE, { type: Events.STATE_CHANGE, state: 'PRICING', attempts: 1, timestamp: Date.now() });
		this.emit(Events.RUN_FAILURE, { type: Events.RUN_FAILURE, error: 'STATE_ERROR: PRICING', timestamp: Date.now() });
		throw new Error('STATE_ERROR: PRICING - PRICING_TRY_FOR_FREE_NO_TRANSITION');
	}
}

describe('TUI E2E', () => {
	it('wizard -> preflight -> confirm -> running -> results (success)', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-e2e-'));
		const initialConfig = validateConfig({ artifacts: { outputDir: tmpDir } });

		const preflightProvider = () => ({ ok: true, checks: [] });
		const orchestratorFactory = () => new FakeOrchestrator();
		const provisionerFactory = () => ({
			provision: async () => ({ address: 'test@example.com', inboxId: 'inbox-test' }),
			cleanup: async () => {},
		});

		const harness = createInkTestHarness(
			React.createElement(App, {
				isActive: true,
				configPath: 'config.yaml',
				initialConfig,
				preflightProvider,
				orchestratorFactory,
				provisionerFactory,
			})
		);

		expect(harness.lastFrame()).toContain('Config Wizard');

		// Wizard -> Preflight
		harness.write('\r');
		await new Promise((r) => setTimeout(r, 25));
		expect(harness.lastFrame()).toContain('Preflight');

		// Preflight -> Confirm
		harness.write('\r');
		await new Promise((r) => setTimeout(r, 25));
		expect(harness.lastFrame()).toContain('Confirm');

		// Confirm -> Running
		harness.write('\r');
		await new Promise((r) => setTimeout(r, 50));
		expect(harness.lastFrame()).toContain('Running');

		// Running -> Results
		await waitForText(harness, 'Results', 1500);
		expect(harness.lastFrame()).toContain('SUCCESS');

		harness.unmount();
		harness.cleanup();
	});

	it('checkpoint flow: shows checkpoint prompt and accepts [y] to proceed', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-e2e-'));
		const initialConfig = validateConfig({ artifacts: { outputDir: tmpDir } });

		const preflightProvider = () => ({ ok: true, checks: [] });
		const orchestratorFactory = ({ checkpointProvider }) => new CheckpointOrchestrator({ checkpointProvider });
		const provisionerFactory = () => ({
			provision: async () => ({ address: 'test@example.com', inboxId: 'inbox-test' }),
			cleanup: async () => {},
		});

		const harness = createInkTestHarness(
			React.createElement(App, {
				isActive: true,
				initialConfig,
				preflightProvider,
				orchestratorFactory,
				provisionerFactory,
			})
		);

		harness.write('\r');
		await new Promise((r) => setTimeout(r, 25));
		harness.write('\r');
		await new Promise((r) => setTimeout(r, 25));
		harness.write('\r');
		await new Promise((r) => setTimeout(r, 50));

		await waitForText(harness, 'CHECKPOINT REQUIRED', 1500);
		harness.write('y');

		await waitForText(harness, 'Results', 1500);
		expect(harness.lastFrame()).toContain('SUCCESS');

		harness.unmount();
		harness.cleanup();
	});

	it('failure flow: ends on Results with readable error', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-e2e-'));
		const initialConfig = validateConfig({ artifacts: { outputDir: tmpDir } });

		const preflightProvider = () => ({ ok: true, checks: [] });
		const orchestratorFactory = () => new FailingOrchestrator();
		const provisionerFactory = () => ({
			provision: async () => ({ address: 'test@example.com', inboxId: 'inbox-test' }),
			cleanup: async () => {},
		});

		const harness = createInkTestHarness(
			React.createElement(App, {
				isActive: true,
				initialConfig,
				preflightProvider,
				orchestratorFactory,
				provisionerFactory,
			})
		);

		harness.write('\r');
		await new Promise((r) => setTimeout(r, 25));
		harness.write('\r');
		await new Promise((r) => setTimeout(r, 25));
		harness.write('\r');
		await new Promise((r) => setTimeout(r, 50));

		await waitForText(harness, 'Results', 1500);
		expect(harness.lastFrame()).toContain('FAILURE');
		expect(harness.lastFrame()).toContain('PRICING_TRY_FOR_FREE_NO_TRANSITION');

		harness.unmount();
		harness.cleanup();
	});
});
