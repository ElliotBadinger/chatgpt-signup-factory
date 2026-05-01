# OpenAI / ChatGPT Deep Auth Capture Design

**Date:** 2026-03-15  
**Status:** Approved

## Objective

Build a Node-first deep capture tool that launches mitmproxy + Chrome + CDP network capture for one manual auth flow, then emits richer backend artifacts and runs catalog analysis automatically.

## Architecture

### New CLI
- `src/cli/pipeline-auth-capture-deep.js`

### New modules
- `src/pipeline/authTrace/deepCapture/runDeepAuthCapture.js`
- `src/pipeline/authTrace/deepCapture/launchMitmproxy.js`
- `src/pipeline/authTrace/deepCapture/attachCdpNetwork.js`
- `src/pipeline/authTrace/deepCapture/deepCaptureArtifacts.js`
- `src/pipeline/authTrace/deepCapture/mergeDeepEvidence.js`

### Existing modules reused
- `src/pipeline/authTrace/artifacts.js`
- `src/pipeline/authTrace/checkpointPlan.js`
- `src/pipeline/authTrace/checkpoints.js`
- `src/pipeline/authTrace/chromeTraceSession.js`
- `src/pipeline/authTrace/launchLocalChrome.js`
- `src/pipeline/authTrace/runCatalogAnalysis.js`

## Capture flow
1. Create run dir
2. Generate mitmproxy addon for run
3. Launch mitmproxy on a local port
4. Launch Chrome through proxy with insecure cert handling enabled
5. Attach CDP Network listeners
6. Guide operator through checkpoint prompts
7. Record browser trace + proxy flows + CDP events
8. Merge deep evidence
9. Emit redirect chains + cookie chronology
10. Run catalog analysis

## Artifacts
- `proxy/flows.jsonl`
- `proxy/mitm-addon.py`
- `cdp/network.jsonl`
- `redirect-chains.json`
- `cookie-chronology.json`
- `deep-merge.json`
- existing auth-trace outputs
- catalog outputs

## Safety
Redact secrets in high-level summaries. Preserve enough metadata for replay analysis. Passwords / OTPs / cookie values / tokens should not be printed to stdout.

## Operator UX
The tool is manual and prompt-driven for phases only:
- landing
- auth-page-loaded
- email-submitted
- otp-page
- otp-submitted
- password-page
- password-submitted
- post-callback
- final

Prompt timing is advisory only; network evidence is authoritative.
