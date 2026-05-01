# Stage 1 live bootstrap proof

## Successful real runs

### Run 1
- root: `agentmailroot1773436577@epistemophile.space`
- state: `state/live-three`
- artifact dir: `artifacts/live-three/controller-agentmailroot1773436577-epistemophile-space`
- mailbox proof: `artifacts/live-three/controller-agentmailroot1773436577-epistemophile-space/mailbox-verification.json`
- controller proof: `artifacts/live-three/controller-agentmailroot1773436577-epistemophile-space/controller-provisioning.json`
- api-key proof: `artifacts/live-three/controller-agentmailroot1773436577-epistemophile-space/api-key-capture.json`
- inbox proof: `artifacts/live-three/controller-agentmailroot1773436577-epistemophile-space/inbox-creation.json`
- outcome: ready controller, API access verified, 3 inboxes created

### Run 2
- root: `agentmailroot17734368281@epistemophile.space`
- state: `state/live-batch`
- artifact dir: `artifacts/live-batch/controller-agentmailroot17734368281-epistemophile-space`
- mailbox proof: `artifacts/live-batch/controller-agentmailroot17734368281-epistemophile-space/mailbox-verification.json`
- controller proof: `artifacts/live-batch/controller-agentmailroot17734368281-epistemophile-space/controller-provisioning.json`
- api-key proof: `artifacts/live-batch/controller-agentmailroot17734368281-epistemophile-space/api-key-capture.json`
- inbox proof: `artifacts/live-batch/controller-agentmailroot17734368281-epistemophile-space/inbox-creation.json`
- outcome: ready controller, API access verified, 3 inboxes created

### Run 3
- root: `agentmailroot17734368282@epistemophile.space`
- state: `state/live-batch`
- artifact dir: `artifacts/live-batch/controller-agentmailroot17734368282-epistemophile-space`
- mailbox proof: `artifacts/live-batch/controller-agentmailroot17734368282-epistemophile-space/mailbox-verification.json`
- controller proof: `artifacts/live-batch/controller-agentmailroot17734368282-epistemophile-space/controller-provisioning.json`
- api-key proof: `artifacts/live-batch/controller-agentmailroot17734368282-epistemophile-space/api-key-capture.json`
- inbox proof: `artifacts/live-batch/controller-agentmailroot17734368282-epistemophile-space/inbox-creation.json`
- outcome: ready controller, API access verified, 3 inboxes created

## Root-cause note captured during execution
Fresh Cloudflare worker routing rules needed propagation time before Clerk verification emails became observable in the mailbox KV. Empirically, a ~70s delay after rule creation made new-root OTP capture deterministic.
