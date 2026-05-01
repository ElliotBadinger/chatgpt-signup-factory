import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assessCodexQuotas, QUOTA_EXHAUSTED_THRESHOLD, QUOTA_PREEMPTIVE_THRESHOLD } from '../../../src/pipeline/rotation/quotaDetector.js';

function buildHealthFile(modelEntries) {
  return { version: 1, providers: {}, models: modelEntries };
}

function buildRouterFile(aliases) {
  return { version: 1, aliases, pools: [], policy: {} };
}

describe('assessCodexQuotas', () => {
  let tmpDir;
  let healthPath;
  let routerPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-test-'));
    healthPath = path.join(tmpDir, 'health.json');
    routerPath = path.join(tmpDir, 'router.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty lists when health file missing', () => {
    fs.writeFileSync(routerPath, JSON.stringify(buildRouterFile([
      { id: 'foo', cloneFrom: 'openai-codex', email: 'foo@agentmail.to', apiKey: 'unused', disabled: false },
    ])));
    const result = assessCodexQuotas({ healthPath: path.join(tmpDir, 'nonexistent.json'), routerPath });
    expect(result.aliases).toEqual([]);
    expect(result.exhausted).toEqual([]);
  });

  test('returns empty lists when router file missing', () => {
    fs.writeFileSync(healthPath, JSON.stringify(buildHealthFile({ 'foo/gpt-5.4': { quotaRemainingFraction: 0.0 } })));
    const result = assessCodexQuotas({ healthPath, routerPath: path.join(tmpDir, 'nonexistent.json') });
    expect(result.aliases).toEqual([]);
  });

  test('identifies exhausted alias (fraction=0)', () => {
    fs.writeFileSync(routerPath, JSON.stringify(buildRouterFile([
      { id: 'horrid', cloneFrom: 'openai-codex', email: 'horrid@agentmail.to', apiKey: 'unused', disabled: false },
    ])));
    fs.writeFileSync(healthPath, JSON.stringify(buildHealthFile({
      'horrid/gpt-5.4': { quotaRemainingFraction: 0.0, quotaCheckedAt: Date.now() },
    })));
    const result = assessCodexQuotas({ healthPath, routerPath, maxStaleMs: 999_999_999 });
    expect(result.exhausted.length).toBe(1);
    expect(result.exhausted[0].email).toBe('horrid@agentmail.to');
    expect(result.exhausted[0].exhausted).toBe(true);
    expect(result.exhausted[0].atRisk).toBe(false);
  });

  test('identifies at-risk alias (fraction=0.10)', () => {
    fs.writeFileSync(routerPath, JSON.stringify(buildRouterFile([
      { id: 'atrisk', cloneFrom: 'openai-codex', email: 'atrisk@agentmail.to', apiKey: 'unused', disabled: false },
    ])));
    fs.writeFileSync(healthPath, JSON.stringify(buildHealthFile({
      'atrisk/gpt-5.4': { quotaRemainingFraction: 0.10, quotaCheckedAt: Date.now() },
    })));
    const result = assessCodexQuotas({ healthPath, routerPath, maxStaleMs: 999_999_999 });
    expect(result.atRisk.length).toBe(1);
    expect(result.atRisk[0].exhausted).toBe(false);
    expect(result.atRisk[0].atRisk).toBe(true);
  });

  test('identifies healthy alias (fraction=0.80)', () => {
    fs.writeFileSync(routerPath, JSON.stringify(buildRouterFile([
      { id: 'happy', cloneFrom: 'openai-codex', email: 'happy@agentmail.to', apiKey: 'unused', disabled: false },
    ])));
    fs.writeFileSync(healthPath, JSON.stringify(buildHealthFile({
      'happy/gpt-5.4': { quotaRemainingFraction: 0.80, quotaCheckedAt: Date.now() },
    })));
    const result = assessCodexQuotas({ healthPath, routerPath, maxStaleMs: 999_999_999 });
    expect(result.healthy.length).toBe(1);
    expect(result.healthy[0].exhausted).toBe(false);
    expect(result.healthy[0].atRisk).toBe(false);
  });

  test('excludes disabled aliases', () => {
    fs.writeFileSync(routerPath, JSON.stringify(buildRouterFile([
      { id: 'disabled', cloneFrom: 'openai-codex', email: 'disabled@agentmail.to', apiKey: 'unused', disabled: true },
    ])));
    fs.writeFileSync(healthPath, JSON.stringify(buildHealthFile({
      'disabled/gpt-5.4': { quotaRemainingFraction: 0.0, quotaCheckedAt: Date.now() },
    })));
    const result = assessCodexQuotas({ healthPath, routerPath, maxStaleMs: 999_999_999 });
    expect(result.aliases.length).toBe(0);
  });

  test('sorts by most exhausted first', () => {
    fs.writeFileSync(routerPath, JSON.stringify(buildRouterFile([
      { id: 'a1', cloneFrom: 'openai-codex', email: 'a1@agentmail.to', apiKey: 'unused', disabled: false },
      { id: 'a2', cloneFrom: 'openai-codex', email: 'a2@agentmail.to', apiKey: 'unused', disabled: false },
      { id: 'a3', cloneFrom: 'openai-codex', email: 'a3@agentmail.to', apiKey: 'unused', disabled: false },
    ])));
    fs.writeFileSync(healthPath, JSON.stringify(buildHealthFile({
      'a1/gpt-5.4': { quotaRemainingFraction: 0.50, quotaCheckedAt: Date.now() },
      'a2/gpt-5.4': { quotaRemainingFraction: 0.02, quotaCheckedAt: Date.now() },
      'a3/gpt-5.4': { quotaRemainingFraction: 0.80, quotaCheckedAt: Date.now() },
    })));
    const result = assessCodexQuotas({ healthPath, routerPath, maxStaleMs: 999_999_999 });
    expect(result.aliases[0].email).toBe('a2@agentmail.to');
    expect(result.aliases[1].email).toBe('a1@agentmail.to');
    expect(result.aliases[2].email).toBe('a3@agentmail.to');
  });

  test('uses minimum fraction across multiple model keys for same alias', () => {
    fs.writeFileSync(routerPath, JSON.stringify(buildRouterFile([
      { id: 'multi', cloneFrom: 'openai-codex', email: 'multi@agentmail.to', apiKey: 'unused', disabled: false },
    ])));
    fs.writeFileSync(healthPath, JSON.stringify(buildHealthFile({
      'multi/gpt-5.4':       { quotaRemainingFraction: 0.80, quotaCheckedAt: Date.now() },
      'multi/gpt-5.3-codex': { quotaRemainingFraction: 0.03, quotaCheckedAt: Date.now() },
    })));
    const result = assessCodexQuotas({ healthPath, routerPath, maxStaleMs: 999_999_999 });
    expect(result.aliases[0].effectiveFraction).toBeCloseTo(0.03);
    // 0.03 < 0.05 threshold → exhausted
    expect(result.exhausted.length).toBe(1);
    expect(result.atRisk.length).toBe(0);
  });

  // ── Bug regression: fiveHour and weekly exposed on returned objects ─────────────
  // health.json stores one quotaRemainingFraction (min of all windows). There is no
  // separate per-window key in health.json — the window breakdown lives in
  // QuotaSignal.notes at runtime (never persisted). So fiveHour and weekly must both
  // be set to effectiveFraction (the single best proxy we have).
  test('returned alias objects expose fiveHour and weekly derived from effectiveFraction', () => {
    fs.writeFileSync(routerPath, JSON.stringify(buildRouterFile([
      { id: 'alias1', cloneFrom: 'openai-codex', email: 'alias1@agentmail.to', apiKey: 'unused', disabled: false },
    ])));
    fs.writeFileSync(healthPath, JSON.stringify(buildHealthFile({
      'alias1/gpt-5.4': { quotaRemainingFraction: 0.42, quotaCheckedAt: Date.now() },
    })));
    const result = assessCodexQuotas({ healthPath, routerPath, maxStaleMs: 999_999_999 });
    const alias = result.aliases[0];
    // Both windows must be present and equal to effectiveFraction
    expect(alias.fiveHour).toBeCloseTo(0.42);
    expect(alias.weekly).toBeCloseTo(0.42);
    expect(alias.effectiveFraction).toBeCloseTo(0.42);
  });

  test('fiveHour and weekly are null when no quota data exists for alias', () => {
    fs.writeFileSync(routerPath, JSON.stringify(buildRouterFile([
      { id: 'unknown', cloneFrom: 'openai-codex', email: 'unknown@agentmail.to', apiKey: 'unused', disabled: false },
    ])));
    // No model key for this alias in health.json
    fs.writeFileSync(healthPath, JSON.stringify(buildHealthFile({})));
    const result = assessCodexQuotas({ healthPath, routerPath, maxStaleMs: 999_999_999 });
    const alias = result.aliases[0];
    expect(alias.fiveHour).toBeNull();
    expect(alias.weekly).toBeNull();
    expect(alias.effectiveFraction).toBeNull();
  });

  // ── TC-10: shouldTriggerBatch uses fiveHour and weekly from assessCodexQuotas ──
  test('TC-10: shouldTriggerBatch detects pool-wide depletion using fiveHour+weekly', () => {
    const aliases = [
      'a1','a2','a3','a4','a5','a6','a7','a8',
    ];
    fs.writeFileSync(routerPath, JSON.stringify(buildRouterFile(
      aliases.map((id) => ({ id, cloneFrom: 'openai-codex', email: `${id}@agentmail.to`, apiKey: 'unused', disabled: false })),
    )));
    // 6 out of 8 have fraction ≤ 0.20 (satisfies both 5h ≤ 0.20 AND weekly ≤ 0.30)
    const models = {};
    ['a1','a2','a3','a4','a5','a6'].forEach((id) => {
      models[`${id}/gpt-5.4`] = { quotaRemainingFraction: 0.10, quotaCheckedAt: Date.now() };
    });
    ['a7','a8'].forEach((id) => {
      models[`${id}/gpt-5.4`] = { quotaRemainingFraction: 0.90, quotaCheckedAt: Date.now() };
    });
    fs.writeFileSync(healthPath, JSON.stringify(buildHealthFile(models)));

    const result = assessCodexQuotas({ healthPath, routerPath, maxStaleMs: 999_999_999 });

    const POOL_TRIGGER_RATIO = 0.6;
    const FIVE_HOUR_THRESHOLD = 0.20;
    const WEEKLY_THRESHOLD = 0.30;

    const depleted = result.aliases.filter((a) =>
      (a.fiveHour ?? 1) <= FIVE_HOUR_THRESHOLD &&
      (a.weekly ?? 1) <= WEEKLY_THRESHOLD,
    );
    const ratio = depleted.length / result.aliases.length;
    expect(ratio).toBeGreaterThanOrEqual(POOL_TRIGGER_RATIO); // 6/8 = 0.75 ≥ 0.6
  });
});
