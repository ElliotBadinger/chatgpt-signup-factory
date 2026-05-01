import {
  detectSplitDobUids,
  findChatInputUid,
  findCheckoutBillingFrameUid,
  findCheckoutPaymentFrameUid,
  selectBestPageFromUrls,
  detectCheckoutProgress,
  isStripeCheckoutUrl,
  findCheckoutCardNumberUid,
  findCheckoutCardExpiryUid,
  findCheckoutCardCvcUid,
  findCheckoutCardholderNameUid,
  findEnterAddressManuallyUid,
  findCheckoutTermsCheckboxUid,
  findPricingTryCtaUid,
} from '../src/SignupFactory.js';

test('selectBestPageFromUrls prefers stripe checkout', () => {
  const urls = ['about:blank', 'https://chatgpt.com/', 'https://checkout.stripe.com/pay/cs_test'];
  expect(selectBestPageFromUrls(urls)).toBe('https://checkout.stripe.com/pay/cs_test');
});

test('selectBestPageFromUrls prefers auth.openai.com over chatgpt.com', () => {
  const urls = ['https://chatgpt.com/', 'https://auth.openai.com/email-verification'];
  expect(selectBestPageFromUrls(urls)).toBe('https://auth.openai.com/email-verification');
});

test('detectSplitDobUids returns day/month/year uids', () => {
  const snapshot = `uid=1_0 RootWebArea
    uid=10_1 spinbutton "Day"
    uid=10_2 spinbutton "Month"
    uid=10_3 spinbutton "Year"`;
  expect(detectSplitDobUids(snapshot)).toEqual({ day: '10_1', month: '10_2', year: '10_3' });
});

test('detectSplitDobUids handles button variant', () => {
  const snapshot = `uid=1_0 RootWebArea
    uid=32_67 button "3 Day"
    uid=32_39 button "February Month"
    uid=32_110 button "2026 Year"`;
  expect(detectSplitDobUids(snapshot)).toEqual({ day: '32_67', month: '32_39', year: '32_110' });
});

test('detectSplitDobUids does not confuse day with Birthday substring', () => {
  const snapshot = `uid=1_0 RootWebArea
    uid=36_35 spinbutton "month, Birthday"
    uid=36_37 spinbutton "day, Birthday"
    uid=36_39 spinbutton "year, Birthday"`;
  expect(detectSplitDobUids(snapshot)).toEqual({ day: '36_37', month: '36_35', year: '36_39' });
});

test('findChatInputUid prefers message textbox near prompt', () => {
  const snapshot = `uid=1_0 RootWebArea
    uid=2_0 paragraph "Ask anything"
    uid=3_0 textbox "Message"`;
  expect(findChatInputUid(snapshot)).toBe('3_0');
});

test('findCheckoutPaymentFrameUid locates payment iframe uid within Payment method section', () => {
  const snapshot = `uid=1_0 RootWebArea
    uid=23_76 heading "Payment method" level="3"
      uid=23_80 IframePresentational "Secure payment input frame"
    uid=23_82 heading "Billing address" level="3"
      uid=23_86 IframePresentational "Secure address input frame"`;
  expect(findCheckoutPaymentFrameUid(snapshot)).toBe('23_80');
});

test('findCheckoutBillingFrameUid locates billing iframe uid within Billing address section (even if iframe title is same)', () => {
  const snapshot = `uid=1_0 RootWebArea
    uid=23_76 heading "Payment method" level="3"
      uid=23_80 IframePresentational "Secure payment input frame"
    uid=23_82 heading "Billing address" level="3"
      uid=23_86 IframePresentational "Secure payment input frame"`;
  expect(findCheckoutBillingFrameUid(snapshot)).toBe('23_86');
});

test('isStripeCheckoutUrl treats pay.openai.com as a stripe-hosted checkout', () => {
  expect(isStripeCheckoutUrl('https://pay.openai.com/c/pay/cs_live_123')).toBe(true);
});

test('selectBestPageFromUrls prefers pay.openai.com checkout over chatgpt.com', () => {
  const urls = ['https://chatgpt.com/', 'https://pay.openai.com/c/pay/cs_live_123'];
  expect(selectBestPageFromUrls(urls)).toBe('https://pay.openai.com/c/pay/cs_live_123');
});

test('detectCheckoutProgress does not treat pay.openai.com URL as progress by itself', () => {
  const snapshot = `uid=1_0 RootWebArea url="https://pay.openai.com/c/pay/cs_live_123"
    uid=2_0 button "Subscribe"`;
  const res = detectCheckoutProgress(snapshot);
  expect(res.progressed).toBe(false);
});

test('checkout field uid helpers find inline Stripe textboxes and manual address button', () => {
  const snapshot = `uid=96_0 RootWebArea url="https://pay.openai.com/c/pay/cs_live_123"
    uid=98_172 textbox "Card number"
    uid=98_193 textbox "Expiration"
    uid=98_200 textbox "CVC"
    uid=98_228 textbox "Cardholder name"
    uid=98_520 button "Enter address manually"`;

  expect(findCheckoutCardNumberUid(snapshot)).toBe('98_172');
  expect(findCheckoutCardExpiryUid(snapshot)).toBe('98_193');
  expect(findCheckoutCardCvcUid(snapshot)).toBe('98_200');
  expect(findCheckoutCardholderNameUid(snapshot)).toBe('98_228');
  expect(findEnterAddressManuallyUid(snapshot)).toBe('98_520');
});

test('findCheckoutTermsCheckboxUid locates checkout terms checkbox', () => {
  const snapshot = `uid=1_0 RootWebArea
    uid=102_478 checkbox "You'll be charged monthly based on the seats you use until you cancel. By subscribing, you agree to OpenAI's Business Terms"`;
  expect(findCheckoutTermsCheckboxUid(snapshot)).toBe('102_478');
});

test('findPricingTryCtaUid finds labeled Try-for button', () => {
  const snapshot = `uid=1_0 RootWebArea url="https://chatgpt.com/#pricing"
    uid=90_150 button "Try for R0"`;
  expect(findPricingTryCtaUid(snapshot)).toBe('90_150');
});

test('findPricingTryCtaUid finds unlabeled primary CTA button near "Try Business free for 1 month" heading', () => {
  const snapshot = `uid=1_0 RootWebArea url="https://chatgpt.com/#pricing"
    uid=81_146 dialog
      uid=81_152 heading "Try Business free for 1 month" level="2"
      uid=81_154 button`;
  expect(findPricingTryCtaUid(snapshot)).toBe('81_154');
});
