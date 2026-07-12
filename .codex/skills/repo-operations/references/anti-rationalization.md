# repo-operations — Anti-Rationalization Table

| Rationalization | Reality |
|---|---|
| "It's cleaner to do this on a fresh branch" | The Branch Discipline Gate (AGENTS.md, HARD RULE) forbids auto-creating branches for convenience. "Creating or staying on a temporary branch when the preserved developer branch should carry the follow-up" is a named ci-watch-and-heal failure. Continue on the existing branch. |
| "I'll switch back to their branch later" | NEVER end a task with the developer parked elsewhere. "Later" is how agents have repeatedly stranded the developer — the gate exists because this actually happened. |
| "The red check is in someone else's lane" | "Treating a red check as someone else's problem" — triage and route it to the owning skill; unrouted red checks compound. |
| "Rerun fixed it, moving on" | "Stopping after rerun without monitoring terminal state" — a rerun that lands green without a cause classification is a masked flake or a masked regression. Watch to terminal state. |
| "It merged, so it deployed" | "Treating every merge as an implicit downstream UAT deploy instead of a separate explicit dispatch" — deploys are explicit dispatches with their own evidence. |
| "Hotfix is on main, incident closed" | "Landing a hotfix on main without back-syncing it into the preserved developer branch" leaves the developer branch carrying the bug. Back-sync is part of the fix. |
| "PR feedback authority covers the queue too" | "Not distinguishing PR feedback from queue authority or post-merge deploy authority" — three separate authorities; holding one grants neither of the others. |
| "Env parity probably held since last deploy" | Env/secret parity is verified per rollout, not assumed from history — parity drift is silent until the deploy that hits it. |

## Red Flags

- Any `git checkout -b` or branch switch without an explicit user request or recorded isolation need
- A handoff message that does not state the final branch and cleanup performed
- A rerun-to-green with no cause classification recorded
- A deploy claim with no Cloud Build/Cloud Run evidence attached
- An incident closed while the developer branch still lacks the fix
