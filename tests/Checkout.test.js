import { isCheckoutSnapshot, findSubscribeUid, findCheckoutPaymentFrameUid, findCheckoutBillingFrameUid, detectCheckoutProgress, findCheckoutEmailUid, findCheckoutSeatsUid } from '../src/SignupFactory.js';

test('isCheckoutSnapshot detects chatgpt checkout url', () => {
    const snapshot = 'uid=1_0 RootWebArea url="https://chatgpt.com/checkout/test"';
    expect(isCheckoutSnapshot(snapshot)).toBe(true);
});

test('isCheckoutSnapshot detects stripe url', () => {
    const snapshot = 'uid=1_0 RootWebArea url="https://checkout.stripe.com/pay/cs_test"';
    expect(isCheckoutSnapshot(snapshot)).toBe(true);
});

test('isCheckoutSnapshot detects Business trial heading', () => {
    const snapshot = 'uid=1_0 RootWebArea\nuid=2_0 heading "Start your free Business trial"';
    expect(isCheckoutSnapshot(snapshot)).toBe(true);
});

test('findCheckoutEmailUid finds various email field variants', () => {
    expect(findCheckoutEmailUid('uid=1_1 textbox "Email"')).toBe('1_1');
    expect(findCheckoutEmailUid('uid=1_2 textbox "Email address"')).toBe('1_2');
    expect(findCheckoutEmailUid('uid=1_3 textbox "Business email"')).toBe('1_3');
});

test('findSubscribeUid finds various button variants', () => {
    expect(findSubscribeUid('uid=2_1 button "Subscribe"')).toBe('2_1');
    expect(findSubscribeUid('uid=2_2 button "Start trial"')).toBe('2_2');
    expect(findSubscribeUid('uid=2_3 button "Pay"')).toBe('2_3');
});

test('findCheckoutPaymentFrameUid and findCheckoutBillingFrameUid identify frames by context', () => {
  const snapshot = `uid=1_0 RootWebArea
    uid=23_76 heading "Payment method" level="3"
      uid=23_80 IframePresentational "Secure frame"
    uid=23_82 heading "Billing address" level="3"
      uid=23_86 IframePresentational "Secure frame"`;
  expect(findCheckoutPaymentFrameUid(snapshot)).toBe('23_80');
  expect(findCheckoutBillingFrameUid(snapshot)).toBe('23_86');
});

test('findCheckoutSeatsUid finds the seats field', () => {
    expect(findCheckoutSeatsUid('uid=5_1 spinbutton "Number of seats" valuetext="2"')).toBe('5_1');
    expect(findCheckoutSeatsUid('uid=5_2 spinbutton valuetext="5"')).toBe('5_2');
});

test('detectCheckoutProgress detects URL change', () => {
    const snapshot = 'uid=1_0 RootWebArea url="https://chatgpt.com/auth/login"';
    const result = detectCheckoutProgress(snapshot);
    expect(result.progressed).toBe(true);
    expect(result.reason).toContain('URL changed');
});

test('detectCheckoutProgress detects confirmation text', () => {
    const snapshot = 'uid=1_0 RootWebArea url="https://chatgpt.com/checkout"\nStaticText "Thank you"';
    const result = detectCheckoutProgress(snapshot);
    expect(result.progressed).toBe(true);
    expect(result.reason).toContain('Confirmation text');
});

test('detectCheckoutProgress detects button disappearance', () => {
    const snapshot = 'uid=1_0 RootWebArea url="https://chatgpt.com/checkout"\nStaticText "Some other text"';
    const result = detectCheckoutProgress(snapshot);
    expect(result.progressed).toBe(true);
    expect(result.reason).toContain('button disappeared');
});

test('detectCheckoutProgress detects disabled button as processing', () => {
    const snapshot = 'uid=1_0 RootWebArea url="https://chatgpt.com/checkout"\nuid=10_5 button "Subscribe" disabled';
    const result = detectCheckoutProgress(snapshot);
    expect(result.progressed).toBe(false);
    expect(result.status).toBe('processing');
});

test('detectCheckoutProgress detects spinner as processing', () => {
    const snapshot = 'uid=1_0 RootWebArea url="https://chatgpt.com/checkout"\nuid=10_5 button "Subscribe"\nStaticText "spinner"';
    const result = detectCheckoutProgress(snapshot);
    expect(result.progressed).toBe(false);
    expect(result.status).toBe('processing');
});
