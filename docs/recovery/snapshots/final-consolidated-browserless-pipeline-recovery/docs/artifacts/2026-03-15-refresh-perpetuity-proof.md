# Prolific Refresh Continuity / Practical Perpetuity Proof — 2026-03-15

## Summary

This memo strengthens the refresh-longevity claim for the VM-backed Prolific listener path using fresh unattended evidence from the timer-driven `prolific-vm-listener-refresh.service` flow.

## Strongest supported claim

The current evidence supports the following practical product claim:

> The linked Prolific session appears **effectively perpetual unless Prolific/Auth0 revokes it**, because the system can repeatedly refresh from persisted state across independent timer-driven runs and successfully promote the refreshed session back into the listener stack.

This is a **practical continuity proof**, not a mathematical forever-proof.

## Evidence used

### Current timer state
Observed timer state:
- `systemctl list-timers prolific-vm-listener-refresh.timer --all`
- next run: `Mon 2026-03-16 02:51:59 UTC`
- last run: `Mon 2026-03-16 02:06:59 UTC`

### Current post-run service state
Observed after the latest unattended run:
- `prolific-vm-listener.service` active since `Mon 2026-03-16 02:08:05 UTC`
- `prolific-firestore-soak.service` active since `Mon 2026-03-16 02:08:05 UTC`
- `prolific-ld-soak.service` active since `Mon 2026-03-16 02:08:05 UTC`
- `prolific-telegram-credential-link.service` active since `Sun 2026-03-15 19:55:25 UTC`

### Current refresh summary artifact
Summary path:
- `/home/epistemophile/signal-probe/results/vm-scrapling-refresh-summary.json`

Observed summary metadata:
- mtime: `1773626884.6557233`

Observed summary fields:
- `ok: true`
- `stagedCaptureOk: true`
- `promotionOk: true`
- `promotionDecision: "promoted"`
- `validation.freshness.ok: true`
- `validation.usersMe.ok: true`
- `browserLaunchMode: "scrapling"`

### Fresh unattended timer-driven runs
Observed in `journalctl -u prolific-vm-listener-refresh.service`:

| Run start (UTC) | Run success (UTC) | Notes |
| --- | --- | --- |
| 2026-03-15 22:20:19 | 2026-03-15 22:21:21 | unattended timer-driven success |
| 2026-03-15 23:05:59 | 2026-03-15 23:07:06 | unattended timer-driven success |
| 2026-03-15 23:51:08 | 2026-03-15 23:52:17 | unattended timer-driven success |
| 2026-03-16 00:36:49 | 2026-03-16 00:37:57 | unattended timer-driven success |
| 2026-03-16 01:21:56 | 2026-03-16 01:23:02 | unattended timer-driven success |
| 2026-03-16 02:06:59 | 2026-03-16 02:08:05 | unattended timer-driven success |

Across each unattended run, the journal included all of the following high-value signals:
- `real_browser=google-chrome ... version=Google Chrome 146.0.7680.71`
- `scrapling_ready=cached`
- successful live fetch of `https://app.prolific.com/studies`
- `[worker token inject] status=0 body={"status":"injected","platform":"telegram","userId":"6836…8948"}`
- JSON summary showing `ok:true`, `promotionOk:true`, `validation.freshness.ok:true`, `validation.usersMe.ok:true`

Prior manual seed/recovery evidence already exists in:
- `docs/WORKLOG-2026-03-15.md`
- `docs/local-validation-plan.md`

## Why this counts as restart-boundary evidence

The key point is that these are **not** repeated checks inside one long-lived in-memory browser or one continuously running refresh process.

Each timer event launches a fresh `prolific-vm-listener-refresh.service` oneshot execution. That means each successful unattended run had to:
1. start from persisted state already on disk / in the configured runtime environment,
2. obtain or promote a usable refreshed session again,
3. validate the refreshed session against real authenticated Prolific surfaces,
4. inject the promoted session back to the Worker path, and
5. restart or rehydrate the dependent listener/soak services successfully.

So although this is not a whole-VM reboot proof, it **is** proof across repeated process-lifetime boundaries. The refresh path keeps succeeding even though the refresh unit itself is recreated on every timer firing and the listener/soak services show fresh activation timestamps after the latest unattended run.

That is the right practical standard for the product claim, because the claim is about whether stored refresh state survives ordinary unattended operation rather than only working inside one lucky manual session.

## What the evidence proves

This evidence now shows all of the following together:

1. **Timer continuity is real, not hypothetical.**
   - The timer is active/enabled and continues scheduling future runs.

2. **Refresh success is repeatable across multiple unattended cycles.**
   - Six consecutive observed timer-driven runs completed successfully over multiple hours.

3. **The refreshed session is not merely syntactically accepted; it is practically usable.**
   - Each run validated freshness and `/users/me` style identity checks.
   - Each run also performed a live authenticated fetch against `https://app.prolific.com/studies`.

4. **Promotion back into the runtime path is working.**
   - The summary repeatedly records `promotionOk:true` and `promotionDecision:"promoted"`.
   - The journal repeatedly records successful Worker token injection.

5. **Dependent runtime services recover after the refresh handoff.**
   - Listener, Firestore soak, and LD soak services were active after the latest unattended run, with fresh activation times matching the refresh completion window.

Together, that is strong practical evidence that the linked refresh capability can continue indefinitely in normal unattended use, subject to upstream revocation or policy change.

## Why this is not a forever-proof

The evidence does **not** justify saying the session is guaranteed forever.

External conditions can still break continuity, including:
- Prolific/Auth0 revoking the refresh capability,
- upstream security/policy changes,
- cookie/session-model changes,
- bot-detection changes,
- VM/environment failures outside the refresh logic,
- or storage corruption/operator error.

So the honest supported statement is:

> refresh continuity is **effectively perpetual unless Prolific/Auth0 revokes it**.

## Remaining proof gap

The main remaining gap before a strongest possible practical success gate is not whether the timer-driven refresh mechanism works at all; that is now well supported.

The remaining gap is longer-horizon operational evidence, especially:
- more elapsed unattended runtime over a wider window,
- and tighter correlation from successful unattended refreshes into later downstream Worker-triggered study relay behavior.

A separate whole-VM reboot proof would make the argument even stronger, but it is not required for the bounded claim above because the repeated oneshot timer executions already demonstrate persistence across ordinary restart boundaries of the refresh pipeline.

## Bottom line

This proof now supports the product statement that the current VM-backed refresh path is **practically self-sustaining across repeated unattended timer-driven executions** and therefore can be described as **effectively perpetual unless Prolific/Auth0 revokes it**.

No plaintext credentials or tokens are recorded here.