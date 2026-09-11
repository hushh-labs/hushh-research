---
name: mobile-bug-log
description: Running reference log of every iOS/mobile bug diagnosed + fixed on the `mobile` branch (symptom → root cause → fix → files/commit), plus the recurring build/runtime gotchas that keep biting. Use when the user asks "what bugs did we fix", "known issues", "list the resolved bugs", "why did X break", when a similar symptom reappears (check if it's a known regression before re-diagnosing), or before shipping a mobile build (re-verify the gotchas). ALWAYS append a new entry here whenever another mobile bug is resolved.
argument-hint: "[optional: keyword to filter, e.g. 'keyboard' | 'backend' | 'navigation']"
allowed-tools: Read Grep Glob Bash(git log*) Bash(git show*) Bash(grep*) Bash(xcrun simctl*)
---

Read `.codex/skills/mobile-parity-audit/SKILL.md` and follow it.

Historical evidence: `docs/reference/mobile/mobile-bug-log.md`.
Release authority: `.codex/skills/repo-operations/references/admin-release-sop.md`.
