import { detectSplitDobUids, findChatInputUid, selectBestPageFromUrls } from '../src/SignupFactory.js';

test('selectBestPageFromUrls prefers stripe checkout', () => {
  const urls = ['about:blank', 'https://chatgpt.com/', 'https://checkout.stripe.com/pay/cs_test'];
  expect(selectBestPageFromUrls(urls)).toBe('https://checkout.stripe.com/pay/cs_test');
});

test('detectSplitDobUids returns day/month/year uids', () => {
  const snapshot = `uid=1_0 RootWebArea
    uid=10_1 spinbutton "Day"
    uid=10_2 spinbutton "Month"
    uid=10_3 spinbutton "Year"`;
  expect(detectSplitDobUids(snapshot)).toEqual({ day: '10_1', month: '10_2', year: '10_3' });
});

test('findChatInputUid prefers message textbox near prompt', () => {
  const snapshot = `uid=1_0 RootWebArea
    uid=2_0 paragraph "Ask anything"
    uid=3_0 textbox "Message"`;
  expect(findChatInputUid(snapshot)).toBe('3_0');
});
