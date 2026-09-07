---
name: run-ios-sim
description: Build, sync, and launch the iOS app on a simulator using the governed native runtime profile and background execution.
---

Read `.codex/skills/mobile-native/SKILL.md` and follow it.

Compatibility entrypoint: `.claude/skills/run-ios-sim/launch.sh [SIMULATOR_UDID]`.
It preserves the legacy UAT default; select `APP_RUNTIME_PROFILE=dev` for private-branch dev validation.
For authenticated journeys, read `.codex/skills/reviewer-app-testing/SKILL.md` and follow it.
