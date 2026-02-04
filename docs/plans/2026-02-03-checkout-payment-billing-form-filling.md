# Checkout Payment + Billing Form Filling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fill ChatGPT checkout payment method + billing address with mocked valid values before clicking “Subscribe”, and fail fast with snapshots/screenshots if fields cannot be found/filled or the post-click state does not change.

**Architecture:**
- Add small pure snapshot helpers to locate the “Secure payment input frame” and billing address frame UIDs.
- Extend `SignupFactory.completeCheckoutForm()` to (1) fill email/seats, (2) fill payment + billing via the iframe UIDs (using puppeteer `contentFrame()`), then (3) click Subscribe only after successful fill.
- After clicking Subscribe, explicitly verify progress (Stripe tab opened OR Subscribe CTA disappears) and fail with artifacts otherwise.

**Tech Stack:** Node.js, Jest, puppeteer (via chrome-devtools-mcp), a11y text snapshots.

---

### Task 1: Add failing tests for payment/billing iframe UID detection

**Files:**
- Modify: `tests/SignupFactoryAboutYou.test.js`

**Step 1: Write the failing tests**

```js
test('findCheckoutPaymentFrameUid locates payment iframe uid within Payment method section', () => {
  const snapshot = `uid=1_0 RootWebArea\n  uid=23_76 heading "Payment method" level="3"\n  uid=23_80 IframePresentational "Secure payment input frame"\n  uid=23_82 heading "Billing address" level="3"\n  uid=23_86 IframePresentational "Secure address input frame"`;
  expect(findCheckoutPaymentFrameUid(snapshot)).toBe('23_80');
});

test('findCheckoutBillingFrameUid locates billing iframe uid within Billing address section (even if iframe title is same)', () => {
  const snapshot = `uid=1_0 RootWebArea\n  uid=23_76 heading "Payment method" level="3"\n  uid=23_80 IframePresentational "Secure payment input frame"\n  uid=23_82 heading "Billing address" level="3"\n  uid=23_86 IframePresentational "Secure payment input frame"`;
  expect(findCheckoutBillingFrameUid(snapshot)).toBe('23_86');
});
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/SignupFactoryAboutYou.test.js`
Expected: FAIL with `findCheckoutPaymentFrameUid is not a function` / missing export.

---

### Task 2: Implement snapshot helper exports

**Files:**
- Modify: `src/SignupFactory.js`

**Step 1: Add minimal implementations**

```js
export function findCheckoutPaymentFrameUid(snapshot) {
  // Scan lines; return first iframe uid after heading "Payment method".
}

export function findCheckoutBillingFrameUid(snapshot) {
  // Scan lines; return first iframe uid after heading "Billing address".
}
```

**Step 2: Run tests**

Run: `npm test tests/SignupFactoryAboutYou.test.js`
Expected: PASS.

---

### Task 3: Extend checkout form completion to fill payment + billing before Subscribe

**Files:**
- Modify: `src/SignupFactory.js` (`completeCheckoutForm()` + small private helpers)

**Step 1: Write a helper that fills Stripe input iframes**
- Use `this.context.getElementByUid(frameUid)` then `await iframeHandle.contentFrame()`.
- In payment frame, fill card number (4242...), expiry (1234), CVC (123), postal (94105) using robust selector fallbacks.
- In billing frame, fill address fields with mocked values (US address) using `autocomplete`-based selectors.
- Verify completion by checking that targeted input values are non-empty.
- On any failure, capture `checkout_*` screenshot + snapshot and call `failWithDebug()`.

**Step 2: Update `completeCheckoutForm()` ordering**
- Fill email + seats.
- Fill payment + billing.
- Take `checkout_form_filled` artifacts.
- Find + click Subscribe.

**Step 3: Verify post-click progress**
- After click, wait briefly and check:
  - Stripe tab open OR Subscribe CTA no longer present.
- If no progress, capture artifacts and `failWithDebug('SUBSCRIBE_CLICK_NO_PROGRESS', snapshot)`.

---

### Task 4: Full verification

**Step 1: Run all tests**

Run: `npm test`
Expected: PASS.

**Step 2: Smoke run (optional)**

Run:
```bash
set -a && source .env && set +a && node src/index.js
```
Expected: Reaches checkout and progresses past Subscribe or fails fast with artifacts.
