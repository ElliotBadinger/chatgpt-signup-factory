# Business Trial Checkout Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure the business trial checkout flow always re-snapshots after the Free offer click, locates the live “Claim free offer” CTA, and advances modal steps with fail-fast artifact capture.

**Architecture:** Add small pure helpers for claim CTA detection and snapshot selection, then update `driveToCheckout` to use snapshot+screenshot per step and enforce fail-fast when expected CTAs are missing. Keep existing Stripe detection but require refreshed snapshot after each click.

**Tech Stack:** Node.js, Jest, chrome-devtools-mcp snapshot tools.

---

### Task 1: Add failing tests for claim CTA helpers

**Files:**
- Modify: `tests/SignupFactoryAboutYou.test.js`

**Step 1: Write the failing tests**

```js
test('findClaimFreeOfferUid locates claim CTA in modal snapshot', () => {
  const snapshot = `uid=1_0 dialog\n  uid=9_1 button "Claim free offer"`;
  expect(findClaimFreeOfferUid(snapshot)).toBe('9_1');
});

test('findCheckoutActionFromSnapshots prefers latest snapshot with action', () => {
  const snapshots = [
    'uid=1_0 RootWebArea\n  uid=1_140 button "Free offer"',
    'uid=1_0 dialog\n  uid=9_1 button "Claim free offer"'
  ];
  expect(findCheckoutActionFromSnapshots(snapshots)).toEqual({ uid: '9_1', snapshot: snapshots[1] });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/SignupFactoryAboutYou.test.js`
Expected: FAIL with `findClaimFreeOfferUid is not defined` / `findCheckoutActionFromSnapshots is not defined`.

---

### Task 2: Implement claim CTA helper exports

**Files:**
- Modify: `src/SignupFactory.js`

**Step 1: Write minimal implementation**

```js
export function findClaimFreeOfferUid(snapshot) {
  if (!snapshot) return null;
  const match = snapshot.match(/uid=(\d+_\d+) (?:button|link) "Claim free offer"/i);
  return match ? match[1] : null;
}

export function findCheckoutActionFromSnapshots(snapshots) {
  if (!snapshots || snapshots.length === 0) return null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const uid = findCheckoutActionUid(snapshots[i]);
    if (uid) return { uid, snapshot: snapshots[i] };
  }
  return null;
}
```

**Step 2: Run test to verify it passes**

Run: `npm test tests/SignupFactoryAboutYou.test.js`
Expected: PASS for new tests.

---

### Task 3: Update checkout flow to re-snapshot + fail fast

**Files:**
- Modify: `src/SignupFactory.js` (driveToCheckout + helper for snapshot+screenshot)

**Step 1: Add snapshot+screenshot helper**

```js
async captureCheckoutSnapshot(tag) {
  const snapshot = await this.getSnapshot();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await this.callTool('take_screenshot', { filePath: `checkout_${tag}_${timestamp}.png` });
  return snapshot;
}
```

**Step 2: Update driveToCheckout**
- After clicking Free offer pill, immediately call `captureCheckoutSnapshot('post_free_offer')` and locate `findClaimFreeOfferUid`.
- If missing, call `captureAmbiguousState('CLAIM_FREE_OFFER_NOT_FOUND', snapshot)` then `failWithDebug`.
- After clicking `Claim free offer`, loop up to `maxModalSteps`:
  - `captureCheckoutSnapshot('modal_step_<n>')`
  - find `findCheckoutActionUid` from current snapshot
  - click and then `getSnapshot()`
  - if no CTA and not checkout, capture ambiguous and fail.

**Step 3: Run test to verify it passes**

Run: `npm test tests/SignupFactoryAboutYou.test.js`
Expected: PASS.

---

### Task 4: Full verification

**Files:**
- None

**Step 1: Run full tests**

Run: `npm test`
Expected: PASS.

**Step 2: Smoke run**

Run:
```
set -a && source /home/epistemophile/chatgpt-factory-bundle/.env && set +a && MAX_RUN_MS=300000 node src/index.js
```
Expected: Flow reaches checkout (Subscribe CTA or Stripe) or fails fast with artifacts.

**Step 3: Commit**

```bash
git add tests/SignupFactoryAboutYou.test.js src/SignupFactory.js docs/plans/2026-02-03-business-trial-checkout-refresh.md
git commit -m "fix: refresh snapshot for claim free offer"
```
