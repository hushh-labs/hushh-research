---
name: wire-voice-action
description: Wire a functional voice action -- one that mutates state, reads and speaks real data, sends/cancels/confirms something, or calls a backend -- into the Kai action gateway. Use for anything on the "Action" list produced by wire-voice-navigation's Step 0 (never for pure "go to this screen" navigation -- that skill handles those directly and this one refuses to). This is a decision guide, not a linear recipe: functional actions genuinely branch on what they do, and picking the wrong branch either silently no-ops or ships an unconfirmed irreversible mutation.
---

Read `.codex/skills/one-voice-governance/SKILL.md` and `.codex/skills/one-voice-governance/references/wire-voice-action.md` and follow them.
