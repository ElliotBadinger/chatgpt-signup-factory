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
});
