import fs from 'fs';
import os from 'os';
import path from 'path';
import React from 'react';
import { render } from 'ink-testing-library';

import { loadConfig } from '../src/config/manager.js';
import { redactConfig } from '../src/config/redaction.js';
import { WizardScreen } from '../src/tui/screens/WizardScreen.js';
import { ConfirmScreen } from '../src/tui/screens/ConfirmScreen.js';
import { mapStateToRunConfig } from '../src/tui/configHelpers.js';

const sampleConfig = {
  run: { headless: false, maxRunMs: 1234, stepTimeoutMs: 5678 },
  identity: { email: 'user@example.com', password: 'super-secret', otpTimeoutMs: 2222 },
  plan: { seats: 7, cadence: 'year' },
  billing: { cardNumber: '4242424242424242', cvc: '123' },
  safety: { requireConfirmBeforeSubscribe: false },
  artifacts: { outputDir: '/tmp/artifacts-test' },
};

describe('Config → TUI integration', () => {
  it('loads YAML config, renders wizard/confirm redaction, and maps run options', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-config-test-'));
    const configPath = path.join(tempDir, 'config.yaml');
    fs.writeFileSync(configPath, [
      'run:',
      '  headless: false',
      '  maxRunMs: 1234',
      '  stepTimeoutMs: 5678',
      'identity:',
      '  email: user@example.com',
      '  password: super-secret',
      '  otpTimeoutMs: 2222',
      'plan:',
      '  seats: 7',
      '  cadence: year',
      'billing:',
      '  cardNumber: "4242424242424242"',
      '  cvc: "123"',
      'safety:',
      '  requireConfirmBeforeSubscribe: false',
      'artifacts:',
      '  outputDir: /tmp/artifacts-test',
      ''
    ].join('\n'));

    const loaded = loadConfig(configPath);

    const wizard = render(React.createElement(WizardScreen, { config: loaded }));
    const wizardFrame = wizard.lastFrame();
    expect(wizardFrame).toContain('Config Wizard');
    expect(wizardFrame).toContain('Artifacts');
    expect(wizardFrame).toContain('/tmp/artifacts-test');
    expect(wizardFrame).toContain('[REDACTED]');
    expect(wizardFrame).not.toContain('super-secret');

    const confirm = render(React.createElement(ConfirmScreen, { configRedacted: redactConfig(loaded) }));
    const confirmFrame = confirm.lastFrame();
    expect(confirmFrame).toContain('Confirm & Start');
    expect(confirmFrame).toContain('[REDACTED]');
    expect(confirmFrame).not.toContain('super-secret');

    process.env.USER_DATA_DIR = '/tmp/user-data';
    const runOptions = mapStateToRunConfig({
      state: loaded,
      provisioned: { address: 'provisioned@example.com', inboxId: 'inbox-123' },
      artifactManager: { getRunDir: () => '/tmp/run-dir' }
    });

    expect(runOptions.headless).toBe(false);
    expect(runOptions.email).toBe('provisioned@example.com');
    expect(runOptions.agentMailInbox).toBe('inbox-123');
    expect(runOptions.password).toBe('super-secret');
    expect(runOptions.runConfig.MAX_RUN_MS).toBe(1234);
    expect(runOptions.runConfig.STEP_TIMEOUT_MS).toBe(5678);
    expect(runOptions.runConfig.OTP_TIMEOUT_MS).toBe(2222);
    expect(runOptions.userDataDir).toBe('/tmp/user-data');
    expect(runOptions.artifactDir).toBe('/tmp/run-dir');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
