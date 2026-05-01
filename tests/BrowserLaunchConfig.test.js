import { buildChromeArgs, getBrowserConfig } from '../src/BrowserLaunchConfig.js';

describe('BrowserLaunchConfig', () => {
  test('buildChromeArgs includes default hardening flags', () => {
    const args = buildChromeArgs({});
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    expect(args).toContain('--lang=en-US,en');
  });

  test('buildChromeArgs appends CHROME_ARGS_EXTRA (split by whitespace)', () => {
    const args = buildChromeArgs({ CHROME_ARGS_EXTRA: '--foo=bar --baz' });
    expect(args).toContain('--foo=bar');
    expect(args).toContain('--baz');
  });

  test('getBrowserConfig parses STEALTH and uses timezone default', () => {
    const cfg = getBrowserConfig({ STEALTH: 'true' });
    expect(cfg.stealth).toBe(true);
    expect(typeof cfg.timezone).toBe('string');
    expect(cfg.timezone.length).toBeGreaterThan(0);
  });
});
