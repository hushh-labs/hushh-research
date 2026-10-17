---
name: ship-testflight
description: Cut a Hussh One iOS build from green main and get it onto your iPhone via TestFlight, self-serve, from any OS including Windows. Use when asked to release/push/cut a TestFlight build, test an iOS fix on a real device, or when a TestFlight dispatch was refused, produced no run at all, or the build never reached testers. Works for any teammate in the UAT allowlist; needs no Mac, no Xcode, and no signing certificates.
allowed-tools: Read Grep Glob Bash(gh *) Bash(git fetch*) Bash(git status*) Bash(git rev-parse*) Bash(git log*) Bash(git merge-base*) Bash(python3 *)
---

# TestFlight compatibility entry point

This is not a second release SOP. Read and follow the canonical guidance:

1. `.codex/skills/repo-operations/references/admin-release-sop.md`
2. `.codex/skills/release-ios-appstore/references/release-proof.md`
3. `docs/guides/mobile/ship-ios-testflight.md`
4. `.github/workflows/ship-ios-testflight.yml`

Use the existing session authorization and the current release contract.
