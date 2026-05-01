import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig, saveConfig, validateConfig } from '../src/config/manager.js';
import { redactConfig } from '../src/config/redaction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempConfigPath = path.join(__dirname, 'temp-config.yaml');

describe('Config (YAML + validation + redaction)', () => {
	afterEach(() => {
		if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
	});

	test('validateConfig applies defaults', () => {
		const cfg = validateConfig({});

		expect(cfg.run.headless).toBe(true);
		expect(cfg.run.stealth).toBe(true);
		expect(cfg.run.maxRunMs).toBe(300000);
		expect(cfg.run.stepTimeoutMs).toBe(60000);

		expect(cfg.identity.otpTimeoutMs).toBe(60000);
		expect(cfg.plan.seats).toBe(5);
		expect(cfg.plan.cadence).toBe('month');

		expect(cfg.safety.requireConfirmBeforeSubscribe).toBe(true);
		expect(cfg.safety.persistSecrets).toBe(false);
		expect(cfg.artifacts.outputDir).toBe('artifacts');
	});

	test('saveConfig and loadConfig roundtrip (YAML)', () => {
		const input = {
			run: { headless: false, stepTimeoutMs: 45000 },
			identity: { email: 'ab@example.com', password: 'pw', otpTimeoutMs: 70000 },
			plan: { seats: 7, cadence: 'year' },
			billing: {
				cardNumber: '4242424242424242',
				expMonth: '12',
				expYear: '34',
				cvc: '123',
				billingZip: '94105',
				billingCountry: 'US',
			},
			safety: { requireConfirmBeforeSubscribe: false, persistSecrets: true },
			artifacts: { outputDir: 'artifacts-test' },
		};

		saveConfig(tempConfigPath, input);
		expect(fs.existsSync(tempConfigPath)).toBe(true);

		const loaded = loadConfig(tempConfigPath);
		const validated = validateConfig(input);

		expect(loaded).toEqual(validated);
	});

	test('redactConfig masks sensitive fields and preserves cardLast4', () => {
		const input = {
			identity: { email: 'ab@example.com', password: 'pw', otpTimeoutMs: 70000 },
			billing: {
				cardNumber: '4242424242424242',
				expMonth: '12',
				expYear: '34',
				cvc: '123',
				billingZip: '94105',
				billingCountry: 'US',
			},
		};

		const redacted = redactConfig(input);

		// original not mutated
		expect(input.identity.password).toBe('pw');
		expect(input.billing.cardNumber).toBe('4242424242424242');

		expect(redacted.identity.email).toBe('ab***@example.com');
		expect(redacted.identity.password).toBe('[REDACTED]');
		expect(redacted.billing.cvc).toBe('[REDACTED]');

		expect(redacted.billing.cardNumber).toBe('**** **** **** 4242');
		expect(redacted.billing.cardLast4).toBe('4242');

		// non-sensitive preserved
		expect(redacted.billing.expMonth).toBe('12');
		expect(redacted.billing.expYear).toBe('34');
		expect(redacted.billing.billingZip).toBe('94105');
	});
});
