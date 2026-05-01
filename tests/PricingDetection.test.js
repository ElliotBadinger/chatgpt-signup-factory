import { ChatGPTStateManager } from '../src/ChatGPTStateManager.js';
import { findPricingTryCtaUid } from '../src/SignupFactory.js';

describe('pricing detection hardening', () => {
  test('detectState: hash #pricing in URL but chat shell visible => CHAT_INTERFACE (not PRICING)', () => {
    const snapshot = [
      'uid=62_0 RootWebArea "ChatGPT" url="https://chatgpt.com/#pricing"',
      'uid=63_122 main',
      'uid=63_131 heading "What are you working on?" level="1"',
      'uid=63_93 button "Open profile menu" expandable haspopup="menu"',
      'uid=64_15 button "Free offer"',
    ].join('\n');

    const sm = new ChatGPTStateManager();
    expect(sm.detectState(snapshot)).toBe('CHAT_INTERFACE');
  });

  test('detectState: pricing upgrade modal markers => PRICING', () => {
    const snapshot = [
      'uid=63_0 RootWebArea "ChatGPT" url="https://chatgpt.com/#pricing"',
      'uid=80_146 dialog',
      'uid=80_152 heading "Upgrade your plan" level="2"',
      'uid=80_158 group "Toggle for switching between Personal and Business plans"',
      'uid=80_164 radio "Toggle for switching to Business plans" checked',
    ].join('\n');

    const sm = new ChatGPTStateManager();
    expect(sm.detectState(snapshot)).toBe('PRICING');
  });

  test('findPricingTryCtaUid: must not treat "Free offer" chat pill as pricing CTA', () => {
    const snapshot = [
      'uid=62_0 RootWebArea "ChatGPT" url="https://chatgpt.com/#pricing"',
      'uid=64_15 button "Free offer"',
      'uid=63_131 heading "What are you working on?" level="1"',
    ].join('\n');

    expect(findPricingTryCtaUid(snapshot)).toBe(null);
  });

  test('findPricingTryCtaUid: finds "Upgrade to Business" button on pricing modal', () => {
    const snapshot = [
      'uid=63_0 RootWebArea "ChatGPT" url="https://chatgpt.com/#pricing"',
      'uid=80_152 heading "Upgrade your plan" level="2"',
      'uid=80_164 radio "Toggle for switching to Business plans" checked',
      'uid=80_241 button "Upgrade to Business"',
    ].join('\n');

    expect(findPricingTryCtaUid(snapshot)).toBe('80_241');
  });
});
