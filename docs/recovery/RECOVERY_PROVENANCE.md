# Consolidated Browserless Pipeline Recovery

Recovered from local Git plus local Codex/Pi session artifacts without mutating the restored worktree.

Seed tracked snapshot:
- /home/epistemophile/Development/chatgpt-factory-bundle/.recovered-source/deterministic-agentmail-pipeline-clone/feat_yutori-browsing-account-creation-0d14ce2d
- commit 0d14ce2d9f7a622940e30e52175bfe4a9772cdfe

Session reconstruction inputs:
- Direct write/edit replay: /home/epistemophile/Development/chatgpt-factory-bundle/.recovered-source/deterministic-agentmail-pipeline-clone/session-replay-write-edit-reconstructed
- Codex apply_patch replay: /home/epistemophile/Development/chatgpt-factory-bundle/.recovered-source/deterministic-agentmail-pipeline-clone/session-replay-from-yutori-plus-april-codexpatch
- Evidence directory: /home/epistemophile/Development/chatgpt-factory-bundle/.recovered-source/deterministic-agentmail-pipeline-clone/_evidence

Important evidence files:
- /home/epistemophile/Development/chatgpt-factory-bundle/.recovered-source/deterministic-agentmail-pipeline-clone/_evidence/write-edit-apply-results.json
- /home/epistemophile/Development/chatgpt-factory-bundle/.recovered-source/deterministic-agentmail-pipeline-clone/_evidence/codexpatch-apply-results.json
- /home/epistemophile/Development/chatgpt-factory-bundle/.recovered-source/deterministic-agentmail-pipeline-clone/_evidence/all-addfile-apply-results.json
- /home/epistemophile/Development/chatgpt-factory-bundle/.recovered-source/deterministic-agentmail-pipeline-clone/_evidence/high-signal-session-files.txt
- /home/epistemophile/Development/chatgpt-factory-bundle/.recovered-source/deterministic-agentmail-pipeline-clone/_evidence/valid-session-mentioned-pipeline-paths.txt

Caveat: This is a best-effort source recovery from session logs. Some edit operations failed because their target/context was unavailable or already superseded. Treat this directory as recovered evidence first; verify before installing into the worktree.
