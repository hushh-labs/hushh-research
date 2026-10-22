---
name: ship-ios-testflight
description: Compatibility entry point for shipping an explicitly authorized green-main iOS build to TestFlight through the governed GitHub workflow.
argument-hint: "[sha: <green-main-sha>] [dry_run: true|false] [require_hardware: true|false] [notes: <what-to-test>]"
allowed-tools: Read Grep Glob Bash(gh *) Bash(git fetch*) Bash(git status*) Bash(git rev-parse*) Bash(git log*) Bash(git branch*)
---

# Ship iOS to TestFlight — governed compatibility bridge

This file is not a second release SOP. Before acting, read and follow:

1. `.agents/skills/repo-operations/references/admin-release-sop.md`
2. `.agents/skills/release-ios-appstore/references/release-proof.md` for shared iOS signing,
   secret-boundary, exact-SHA, and honest-reporting rules
3. `docs/guides/mobile/ship-ios-testflight.md`
4. `.github/workflows/ship-ios-testflight.yml`

TestFlight dispatch requires an explicit user request and confirmation, a green landed `main` SHA,
and an actor authorized by the current `config/ci-governance.json`. Follow `release-proof.md` →
Live version and concurrent-release admission before packaging and when reconciling visibility:
compare live Apple marketing versions, retained/in-flight uploads and the actual automatic tester
group with the intended candidate; the source version or a higher build number alone is insufficient.
Never hardcode the next version or assume one workflow serializes every developer. Never read secret
values, mutate Cloud Run directly, merge code, deploy UAT, deploy production, or submit App Store
review as an implied part of this task. Watch the workflow to a terminal state and distinguish
workflow success, upload, Apple processing, and tester availability in the report.
