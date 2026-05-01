# Phase 01 E2E Trial Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the E2E trial flow fail-fast, reliably verify chat handshake, and drive to Stripe checkout after verification with debug artifacts on failure.

**Architecture:** Extend SignupFactory with stricter verification handling, more robust chat input targeting, and a checkout navigation helper that confirms Stripe URLs. Update tests for new helper behaviors.

**Tech Stack:** Node.js, Jest, Chrome DevTools MCP.

---

### Task 1: Add tests for improved chat input targeting

**Files:**
- Modify: `tests/SignupFactoryAboutYou.test.js`

**Step 1: Write the failing test**

```javascript
test('findChatInputUid prefers inputs near send button', () => {
  const snapshot = `uid=1_0 RootWebArea
    uid=10_0 textbox "Message"
    uid=11_0 button "Send"
    uid=20_0 textbox "Message"`;
  expect(findChatInputUid(snapshot)).toBe('10_0');
});
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/SignupFactoryAboutYou.test.js -t "prefers inputs near send button"`
Expected: FAIL - returns wrong uid or null.

**Step 3: Write minimal implementation**

Update `findChatInputUid` to score candidates by proximity to send button lines and message/prompt cues.

**Step 4: Run test to verify it passes**

Run: `npm test tests/SignupFactoryAboutYou.test.js -t "prefers inputs near send button"`
Expected: PASS.

**Step 5: Commit**

```bash
git add tests/SignupFactoryAboutYou.test.js src/SignupFactory.js
git commit -m "test: cover chat input send button proximity"
```

### Task 2: Add tests for Stripe URL detection helper

**Files:**
- Modify: `tests/SignupFactoryAboutYou.test.js`
- Modify: `src/SignupFactory.js`

**Step 1: Write the failing test**

```javascript
test('isStripeCheckoutUrl identifies stripe checkout urls', () => {
  expect(isStripeCheckoutUrl('https://checkout.stripe.com/pay/cs_test')).toBe(true);
  expect(isStripeCheckoutUrl('https://stripe.com/pay/cs_test')).toBe(true);
  expect(isStripeCheckoutUrl('https://chatgpt.com/')).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/SignupFactoryAboutYou.test.js -t "isStripeCheckoutUrl"`
Expected: FAIL - function missing.

**Step 3: Write minimal implementation**

Add `isStripeCheckoutUrl` helper to `src/SignupFactory.js` and export it.

**Step 4: Run test to verify it passes**

Run: `npm test tests/SignupFactoryAboutYou.test.js -t "isStripeCheckoutUrl"`
Expected: PASS.

**Step 5: Commit**

```bash
git add tests/SignupFactoryAboutYou.test.js src/SignupFactory.js
git commit -m "test: add stripe checkout url helper coverage"
```

### Task 3: Implement verification fail-fast + improved input targeting

**Files:**
- Modify: `src/SignupFactory.js`

**Step 1: Write the failing test**

Add or update tests from Task 1 to require the new targeting logic (already red).

**Step 2: Run test to verify it fails**

Run: `npm test tests/SignupFactoryAboutYou.test.js -t "prefers inputs near send button"`
Expected: FAIL before implementation.

**Step 3: Write minimal implementation**

- Update `findChatInputUid` to parse snapshot lines, score candidates by message/prompt text and proximity to send button.
- Update `verifyAccount` to return boolean and call `failWithDebug` if handshake not found after retries.
- Ensure `run` aborts on verification failure.

**Step 4: Run test to verify it passes**

Run: `npm test tests/SignupFactoryAboutYou.test.js -t "prefers inputs near send button"`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/SignupFactory.js
git commit -m "feat: fail fast on verification and improve chat input targeting"
```

### Task 4: Implement checkout navigation and Stripe confirmation

**Files:**
- Modify: `src/SignupFactory.js`

**Step 1: Write the failing test**

Add or update tests from Task 2 to require the new helper (already red).

**Step 2: Run test to verify it fails**

Run: `npm test tests/SignupFactoryAboutYou.test.js -t "isStripeCheckoutUrl"`
Expected: FAIL before implementation.

**Step 3: Write minimal implementation**

- Add `driveToCheckout` method that attempts to click upgrade/plan UI or navigates to known upgrade URLs.
- After each action, select best page via `selectBestPageFromUrls` and confirm `isStripeCheckoutUrl` before success.
- Call `driveToCheckout` after successful verification, fail with debug artifacts if checkout cannot be reached within timeout.

**Step 4: Run test to verify it passes**

Run: `npm test tests/SignupFactoryAboutYou.test.js -t "isStripeCheckoutUrl"`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/SignupFactory.js
git commit -m "feat: drive to checkout and confirm stripe tab"
```

### Task 5: Verify full suite + smoke run

**Files:**
- None

**Step 1: Run tests**

Run: `npm test`
Expected: PASS.

**Step 2: Run smoke**

Run: `AGENTMAIL_API_KEY=... MAX_RUN_MS=300000 node src/index.js`
Expected: SUCCESS with verification + Stripe confirmation.

**Step 3: Commit (if needed)**

```bash
git add docs/plans/2026-02-03-phase01-e2e-trial.md
git commit -m "docs: add phase01 e2e trial implementation plan"
```
