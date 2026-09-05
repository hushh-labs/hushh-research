---
name: safe-changes
description: Pre-flight rules that stop a change in this repo from breaking an
  unrelated live feature. Use BEFORE editing any deploy config, secret, IAM
  policy, shared credential, or infrastructure resource, and before deploying.
  Each rule was written after a real incident; add a new one every time a
  mistake is found.
---

Read `.codex/skills/repo-operations/SKILL.md` and follow it.

Historical evidence: `docs/reference/operations/safe-changes-history.md`.
Release authority: `.codex/skills/repo-operations/references/admin-release-sop.md`.
