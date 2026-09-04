---
name: release-ios-appstore
description: Compatibility entry point for the canonical Hushh iOS App Store release skill. Use only when explicitly asked to prepare or submit an App Store release.
argument-hint: "[sha: <green-main-sha>] [dry_run: true|false] [whats_new: <text>] [submit: true|false] [notes: <text>]"
allowed-tools: Read Grep Glob Bash(make ios-prod-release*) Bash(make ios-prod-release-dry*) Bash(node scripts/release/dispatch-ios-appstore.mjs*) Bash(gh *) Bash(git fetch*) Bash(git status*) Bash(git rev-parse*) Bash(git log*) Bash(git branch*)
---

# Release iOS to App Store — compatibility bridge

This file is not an independent release procedure. The canonical authored contract is:

1. `.codex/skills/repo-operations/references/admin-release-sop.md`
2. `.codex/skills/release-ios-appstore/SKILL.md`
3. `.codex/skills/release-ios-appstore/references/release-proof.md`
4. `docs/guides/mobile/release-ios-appstore.md`

Read all four before taking action and follow them verbatim. Actor authorization comes from
`config/ci-governance.json`; version/build values come from the repository and workflow. Never
hardcode either. App Store dispatch and public submission are separate explicit authority gates.
This bridge must never grow its own commands, operator lists, secret procedure, or release policy.
