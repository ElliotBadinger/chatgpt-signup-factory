# TUI Encrypted Persistence Vault (Design)

## Goal
Persist a provisioned account (email/password/AgentMail inbox) and billing credentials across successful TUI runs, encrypted with a user‑provided passcode. The vault must never store secrets unencrypted and must not write secrets into artifacts or logs.

## Scope
- **TUI‑only** persistence (no headless integration for now).
- **Config‑gated** via `safety.persistSecrets: true`.
- **Storage location:** `~/.account-factory/account.enc.json`.
- **Passcode prompt:** before the run starts.
- **Existing vault:** prompt to unlock and prefill wizard fields.
- **Encryption:** AES‑256‑GCM with PBKDF2‑derived key (SHA‑256, random salt, high iterations).

## Architecture & Data Flow
1. **Startup (TUI only)**
   - If `safety.persistSecrets` is `true`, prompt for passcode before continuing.
   - If vault exists: prompt to unlock and **prefill** account + billing fields.
   - If vault does not exist: prompt to create passcode **with confirmation**.

2. **Run lifecycle**
   - Use the prefilled (or manually entered) values for the run.
   - On **successful completion**, persist account + billing to vault.
   - On failure, no vault write occurs.

3. **Storage & encryption**
   - Vault file: `~/.account-factory/account.enc.json`.
   - File format (base64):
     ```json
     {
       "version": 1,
       "kdf": {"salt": "...", "iterations": 200000, "digest": "sha256"},
       "cipher": {"iv": "...", "tag": "...", "ciphertext": "..."}
     }
     ```
   - AES‑256‑GCM key derived from passcode using PBKDF2.
   - Passcode never written to disk; cleared from memory after use.

## UX & Error Handling
- **Unlock flow:** retry on wrong passcode; allow cancel (continue without prefill).
- **Create flow:** require passcode confirmation; mismatch prompts retry.
- **Save errors:** show non‑fatal warning in Results screen.
- **No secret leakage:** never write secrets to logs, artifacts, or run bundle.

## Persisted Fields
- Account: `email`, `password`, `agentMailInbox`.
- Billing: `cardNumber`, `expMonth`, `expYear`, `cvc`, `billingZip`, `billingCountry`.

## Testing Plan (TDD)
- **Unit tests** for vault:
  - Encrypt/decrypt round trip.
  - Wrong passcode fails and does not mutate existing data.
  - File format contains required fields.
  - PBKDF2 parameters honored.
- **TUI integration tests**:
  - Prompt behavior with `persistSecrets: true`.
  - Unlock prefill success & retry path on failure.
  - Create passcode with confirmation (mismatch rejected).
  - No vault behavior when `persistSecrets: false`.
- **Regression**:
  - Vault write only on success.
  - Vault file never appears in artifacts/run bundle.

## Follow‑ups (Out of scope)
- Headless flow integration.
- OS keychain support.
