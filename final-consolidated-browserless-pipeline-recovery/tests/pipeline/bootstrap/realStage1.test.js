import { describe, expect, jest, test } from '@jest/globals';

import { RealChromeAgentMailDriver } from '../../../src/pipeline/bootstrap/realStage1.js';

describe('RealChromeAgentMailDriver.ensureOrganizationSelected', () => {
  test('falls back to clicking an organization when Clerk setActive leaves the page on select-organization', async () => {
    const driver = new RealChromeAgentMailDriver({
      env: {},
      mailboxAuthority: {},
      chromePath: '/usr/bin/google-chrome-stable',
    });
    const page = {
      evaluate: jest.fn().mockResolvedValue({
        action: 'set-active',
        orgId: 'org_123',
        href: 'https://console.agentmail.to/select-organization',
      }),
      url: jest.fn().mockReturnValue('https://console.agentmail.to/select-organization'),
    };
    driver.ensureOrganizationSelectedByClick = jest.fn().mockResolvedValue();

    await driver.ensureOrganizationSelected(page);

    expect(driver.ensureOrganizationSelectedByClick).toHaveBeenCalledWith(page);
  });

  test('does not click-select when Clerk selection already left the select-organization page', async () => {
    const driver = new RealChromeAgentMailDriver({
      env: {},
      mailboxAuthority: {},
      chromePath: '/usr/bin/google-chrome-stable',
    });
    const page = {
      evaluate: jest.fn().mockResolvedValue({
        action: 'set-active',
        orgId: 'org_123',
        href: 'https://console.agentmail.to/dashboard/overview',
      }),
      url: jest.fn().mockReturnValue('https://console.agentmail.to/dashboard/overview'),
    };
    driver.ensureOrganizationSelectedByClick = jest.fn().mockResolvedValue();

    await driver.ensureOrganizationSelected(page);

    expect(driver.ensureOrganizationSelectedByClick).not.toHaveBeenCalled();
  });
});
