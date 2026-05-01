import { ChatGPTStateManager } from '../src/ChatGPTStateManager.js';

describe('ChatGPTStateManager', () => {
  const manager = new ChatGPTStateManager();

  test('should detect LANDING state', () => {
    const snapshot = `uid=1_0 RootWebArea "Get started | ChatGPT"
  uid=1_4 button "Log in"
  uid=1_5 button "Sign up for free"`;
    expect(manager.detectState(snapshot)).toBe('LANDING');
  });

  test('should detect LOGIN_EMAIL state', () => {
    const snapshot = `uid=5_0 RootWebArea "Log in or sign up - OpenAI"
  uid=5_12 textbox "Email address" focusable focused`;
    expect(manager.detectState(snapshot)).toBe('LOGIN_EMAIL');
  });

  test('should detect LOGIN_PASSWORD state', () => {
    const snapshot = `uid=3_0 RootWebArea "Create a password - OpenAI"
  uid=5_10 textbox "Password" focusable focused`;
    expect(manager.detectState(snapshot)).toBe('LOGIN_PASSWORD');
  });

  test('should detect OTP_VERIFICATION state', () => {
    const snapshot = `uid=7_0 RootWebArea "Check your inbox - OpenAI"
  uid=7_7 textbox "Code"`;
    expect(manager.detectState(snapshot)).toBe('OTP_VERIFICATION');
  });

  test('should detect ABOUT_YOU state', () => {
    const snapshot = `uid=1_0 RootWebArea "Let's confirm your age - OpenAI"
  uid=1_9 textbox "Full name"`;
    expect(manager.detectState(snapshot)).toBe('ABOUT_YOU');
  });

  test('should detect CHAT_INTERFACE state', () => {
    const snapshot = `uid=1_0 RootWebArea "ChatGPT"
  uid=1_37 generic focusable focused
    uid=1_38 paragraph
      uid=1_10 StaticText "Ask anything"`;
    expect(manager.detectState(snapshot)).toBe('CHAT_INTERFACE');
  });

  test('detects ONBOARDING when onboarding question shown even if chat shell is present', () => {
    const snapshot = `uid=1_0 RootWebArea "ChatGPT" url="https://chatgpt.com/"
      uid=60_8 heading "What brings you to ChatGPT?" level="1"
      uid=60_38 button "Skip"
      uid=60_68 link "New chat"`;
    expect(manager.detectState(snapshot)).toBe('ONBOARDING');
  });

  test('detects ONBOARDING for the in-chat tour overlay ("Skip Tour")', () => {
    const snapshot = `uid=1_0 RootWebArea "ChatGPT"
      uid=80_12 button "Next"
      uid=80_15 button "Skip Tour"
      uid=80_27 button "Free offer"`;
    expect(manager.detectState(snapshot)).toBe('ONBOARDING');
  });

  test('detects CHAT_INTERFACE for What can I help with?', () => {
    const snapshot = `uid=1_0 RootWebArea "ChatGPT"
    uid=1_10 StaticText "What can I help with?"
    uid=1_20 paragraph`;
    expect(manager.detectState(snapshot)).toBe('CHAT_INTERFACE');
  });

  test('detects CHAT_INTERFACE for profile menu', () => {
    const snapshot = `uid=1_0 RootWebArea "ChatGPT"
    uid=1_144 button "Open profile menu"`;
    expect(manager.detectState(snapshot)).toBe('CHAT_INTERFACE');
  });

  test('detects CHAT_INTERFACE for new chat button', () => {
    const snapshot = `uid=1_0 RootWebArea "ChatGPT"
    uid=1_31 link "New chat Shift Command O"`;
    expect(manager.detectState(snapshot)).toBe('CHAT_INTERFACE');
  });

  test('detects ACCESS_DENIED', () => {
    const snapshot = `Access denied\nReference #123`;
    expect(manager.detectState(snapshot)).toBe('ACCESS_DENIED');
  });

  test('detects CHAT_INTERFACE for What’s on your mind today?', () => {
    const snapshot = `uid=1_0 RootWebArea "ChatGPT"
    uid=1_10 StaticText "What’s on your mind today?"
    uid=1_20 paragraph`;
    expect(manager.detectState(snapshot)).toBe('CHAT_INTERFACE');
  });

  test('detects LANDING for Your session has ended', () => {
    const snapshot = `uid=7_0 RootWebArea "Your session has ended - OpenAI"
    uid=7_14 link "Log in"`;
    expect(manager.detectState(snapshot)).toBe('LANDING');
  });

  test('detects OTP_VERIFICATION for Verify your email', () => {
    const snapshot = `uid=7_0 RootWebArea "Verify your email - OpenAI"
    uid=7_7 StaticText "Verify your email to continue"`;
    expect(manager.detectState(snapshot)).toBe('OTP_VERIFICATION');
  });

  test('detects BLOCKED for Cloudflare turnstile variations', () => {
    const s1 = `uid=7_1 RootWebArea "Checking your Browser…"`;
    const s2 = `uid=7_0 Iframe "Widget containing a Cloudflare security challenge"`;
    const s3 = `uid=9_3 checkbox "Verify you are human"`;
    
    expect(manager.detectState(s1)).toBe('BLOCKED');
    expect(manager.detectState(s2)).toBe('BLOCKED');
    expect(manager.detectState(s3)).toBe('BLOCKED');
  });

  test('detects CHECKOUT state', () => {
    const s1 = `uid=1_0 RootWebArea "ChatGPT" url="https://chatgpt.com/checkout"`;
    const s2 = `uid=23_76 heading "Payment method" level="3"`;
    const s3 = `uid=1_5 button "Subscribe"`;
    const s4 = `uid=1_10 StaticText "Start your free Business trial"`;

    expect(manager.detectState(s1)).toBe('CHECKOUT');
    expect(manager.detectState(s2)).toBe('CHECKOUT');
    expect(manager.detectState(s3)).toBe('CHECKOUT');
    expect(manager.detectState(s4)).toBe('CHECKOUT');
  });

  test('detects PRICING state for chatgpt.com/#pricing business trial page', () => {
    const s = `uid=1_0 RootWebArea "ChatGPT" url="https://chatgpt.com/#pricing"
      uid=1_10 heading "Try Business free for 1 month" level="2"
      uid=1_15 button "Try for free"`;

    expect(manager.detectState(s)).toBe('PRICING');
  });

  test('detects BUSINESS_TRIAL_PLAN_PICKER for team pricing seat selection', () => {
    const s = `uid=1_0 RootWebArea "ChatGPT" url="https://chatgpt.com/?numSeats=5&selectedPlan=month#team-pricing-seat-selection"
      uid=1_10 button "Continue to billing"`;

    expect(manager.detectState(s)).toBe('BUSINESS_TRIAL_PLAN_PICKER');
  });

  test('detects ONBOARDING for "Stay logged in" and "Get started"', () => {
    const s1 = `uid=1_10 heading "Stay logged in"`;
    const s2 = `uid=1_15 button "Get started"`;
    const s3 = `uid=1_10 heading "Help us improve"`;
    
    expect(manager.detectState(s1)).toBe('ONBOARDING');
    expect(manager.detectState(s2)).toBe('ONBOARDING');
    expect(manager.detectState(s3)).toBe('ONBOARDING');
  });

  test('detects OTP_VERIFICATION for "Enter the code" and "Verification code"', () => {
    const s1 = `uid=1_5 StaticText "Enter the code"`;
    const s2 = `uid=1_5 textbox "Verification code"`;
    expect(manager.detectState(s1)).toBe('OTP_VERIFICATION');
    expect(manager.detectState(s2)).toBe('OTP_VERIFICATION');
  });

  test('detects ABOUT_YOU for "Birthday" and "Date of birth"', () => {
    const s1 = `uid=1_5 StaticText "Birthday"`;
    const s2 = `uid=1_5 StaticText "Date of birth"`;
    expect(manager.detectState(s1)).toBe('ABOUT_YOU');
    expect(manager.detectState(s2)).toBe('ABOUT_YOU');
  });

  test('detects AUTH_ERROR for "Oops, an error occurred" and variations', () => {
    const s1 = `uid=1_5 StaticText "Oops, an error occurred"`;
    const s2 = `uid=1_5 StaticText "Something went wrong"`;
    const s3 = `uid=1_5 StaticText "An error occurred during authentication"`;
    const s4 = `uid=1_5 StaticText "There was an error when trying to log in"`;
    const s5 = `url="https://chatgpt.com/auth-error"`;

    expect(manager.detectState(s1)).toBe('AUTH_ERROR');
    expect(manager.detectState(s2)).toBe('AUTH_ERROR');
    expect(manager.detectState(s3)).toBe('AUTH_ERROR');
    expect(manager.detectState(s4)).toBe('AUTH_ERROR');
    expect(manager.detectState(s5)).toBe('AUTH_ERROR');
  });
});
