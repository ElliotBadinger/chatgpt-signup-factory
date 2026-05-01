# Codex Quota Health Safety Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make account-router safer immediately by preventing ambiguous quota proof from suppressing refreshes and by tightening strict quota-proof handling around routing decisions.

**Architecture:** Implement a small first slice of the larger quota-health redesign. Keep the existing health-store schema, but add explicit helpers so callers can distinguish complete vs ambiguous proof. Update the global poll planner to keep refreshing ambiguous proofs instead of treating them as healthy-enough. Cover the behavior with focused tests first.

**Tech Stack:** TypeScript, Node test runner, pi account-router extension tests.

---

### Task 1: Add failing tests for ambiguous-proof refresh behavior

**Files:**
- Modify: `/home/epistemophile/.pi/agent/extensions/account-router/tests/health-store.test.ts`
- Modify: `/home/epistemophile/.pi/agent/extensions/account-router/tests/global-poll-planner.test.ts`

- [ ] **Step 1: Write failing health-store test for complete vs ambiguous proof**

Add this test to `tests/health-store.test.ts`:

```ts
  it("distinguishes complete quota proof from ambiguous quota proof", () => {
    const s = new AccountHealthStore("/dev/null");
    s.recordQuotaProof("p", "m", 1000, 0.42, { ambiguous: true });

    assert.strictEqual(s.isQuotaProofFresh("p", "m", 1500, 1000), true);
    assert.strictEqual(s.isQuotaProofFreshAndUnambiguous("p", "m", 1500, 1000), false);

    s.recordQuotaProof("p", "m", 2000, 0.42, { ambiguous: false });
    assert.strictEqual(s.isQuotaProofFreshAndUnambiguous("p", "m", 2500, 1000), true);
  });
```

- [ ] **Step 2: Write failing planner test showing ambiguous proof should still be re-polled**

Add this test to `tests/global-poll-planner.test.ts`:

```ts
  it("does not suppress polling when the only fresh quota proof is ambiguous", () => {
    const now = 1_000_000;
    const h = new AccountHealthStore("/dev/null");

    h.recordQuotaProof("amb", "m", now - 1000, 1, { ambiguous: true });

    const plan = planNextGlobalProbe({
      now,
      activeRoute: { provider: "other", model: "m" },
      dashboardPoolRoutes: [{ provider: "amb", model: "m" }],
      allRoutes: [
        { provider: "other", model: "m" },
        { provider: "amb", model: "m" },
      ],
      cursor: 0,
      lastProbeAt: 0,
      minIntervalMs: 0,
      okTtlMs: 60_000,
      negativeTtlMs: 60_000,
      quotaProofTtlMs: 20_000,
      health: h,
      hasAuth: () => true,
      modelExists: () => true,
    });

    assert.deepStrictEqual(plan.routeToProbe, { provider: "amb", model: "m" });
  });
```

- [ ] **Step 3: Run the targeted tests to verify they fail**

Run:

```bash
cd /home/epistemophile/.pi/agent/extensions/account-router && node --test tests/health-store.test.ts tests/global-poll-planner.test.ts
```

Expected: FAIL with `isQuotaProofFreshAndUnambiguous is not a function` and/or planner still skipping ambiguous proof.

### Task 2: Implement explicit complete-proof helper in health-store

**Files:**
- Modify: `/home/epistemophile/.pi/agent/extensions/account-router/health-store.ts`
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/health-store.test.ts`

- [ ] **Step 1: Add the helper method**

Add this method to `AccountHealthStore` near `isQuotaProofFresh(...)`:

```ts
  isQuotaProofFreshAndUnambiguous(provider: string, modelId: string, now: number, ttlMs: number): boolean {
    const proof = this.getQuotaProof(provider, modelId);
    if (!proof) return false;
    if (proof.ambiguous) return false;
    return now - proof.checkedAt <= ttlMs;
  }
```

- [ ] **Step 2: Run health-store tests**

Run:

```bash
cd /home/epistemophile/.pi/agent/extensions/account-router && node --test tests/health-store.test.ts
```

Expected: PASS

### Task 3: Update the global poll planner to keep refreshing ambiguous proofs

**Files:**
- Modify: `/home/epistemophile/.pi/agent/extensions/account-router/global-poll-planner.ts`
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/global-poll-planner.test.ts`

- [ ] **Step 1: Change the fresh-proof suppression rule**

Replace this block in `global-poll-planner.ts`:

```ts
  if (input.health.isQuotaProofFresh(r.provider, r.model, input.now, input.quotaProofTtlMs)) return false;
```

with:

```ts
  if (input.health.isQuotaProofFreshAndUnambiguous(r.provider, r.model, input.now, input.quotaProofTtlMs)) {
    return false;
  }
```

- [ ] **Step 2: Clarify the comment to match the new semantics**

Replace:

```ts
  // Global poller primarily maintains fresh strict quota proof for failover.
  // Skip only when a recent quota proof exists (positive or zero).
```

with:

```ts
  // Global poller primarily maintains fresh strict quota proof for failover.
  // Ambiguous/partial proof is not good enough to suppress refreshes.
  // Skip only when a recent unambiguous quota proof exists.
```

- [ ] **Step 3: Run planner tests**

Run:

```bash
cd /home/epistemophile/.pi/agent/extensions/account-router && node --test tests/global-poll-planner.test.ts
```

Expected: PASS

### Task 4: Run focused regression verification

**Files:**
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/route-selection-strict.test.ts`
- Test: `/home/epistemophile/.pi/agent/extensions/account-router/tests/quota-proof-state.test.ts`

- [ ] **Step 1: Run the strict quota-related regression suite**

Run:

```bash
cd /home/epistemophile/.pi/agent/extensions/account-router && node --test tests/health-store.test.ts tests/global-poll-planner.test.ts tests/route-selection-strict.test.ts tests/quota-proof-state.test.ts
```

Expected: PASS

- [ ] **Step 2: Run a broader polling/health slice**

Run:

```bash
cd /home/epistemophile/.pi/agent/extensions/account-router && node --test tests/global-poller.test.ts tests/availability-state.test.ts tests/dashboard-quota-freshness.test.ts
```

Expected: PASS

### Task 5: Live-state E2E sanity check against current health file

**Files:**
- Read-only verification against: `/home/epistemophile/.pi/agent/account-router-health.json`

- [ ] **Step 1: Confirm live ambiguous entries remain refresh-eligible conceptually**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const p = '/home/epistemophile/.pi/agent/account-router-health.json';
const data = JSON.parse(fs.readFileSync(p, 'utf8'));
const rows = Object.entries(data.models)
  .filter(([, v]) => v && v.quotaCheckedAt && v.quotaProofAmbiguous)
  .slice(0, 10)
  .map(([k, v]) => ({ key: k, quotaCheckedAt: v.quotaCheckedAt, quotaRemainingFraction: v.quotaRemainingFraction }));
console.log(JSON.stringify(rows, null, 2));
NODE
```

Expected: prints currently ambiguous routes that, after this change, would no longer be suppressed by the planner merely because the proof is fresh.

### Task 6: Final verification

**Files:**
- None

- [ ] **Step 1: Re-run the complete targeted verification command before claiming success**

Run:

```bash
cd /home/epistemophile/.pi/agent/extensions/account-router && node --test tests/health-store.test.ts tests/global-poll-planner.test.ts tests/route-selection-strict.test.ts tests/quota-proof-state.test.ts tests/global-poller.test.ts tests/availability-state.test.ts tests/dashboard-quota-freshness.test.ts
```

Expected: PASS
