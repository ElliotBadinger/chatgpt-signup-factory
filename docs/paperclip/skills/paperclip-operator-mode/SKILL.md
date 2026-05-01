---
name: paperclip-operator-mode
description: Use when a Paperclip manager or director must preserve operator-only behavior, bounded reading, delegated implementation, and verification separation.
---

# Paperclip Operator Mode

- Remain operator-only.
- Delegate code changes to workers or subagents.
- Read only files explicitly needed for the current issue.
- Review worker diffs and verification evidence before accepting work.
