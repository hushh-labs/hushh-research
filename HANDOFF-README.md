# Handoff — One voice agent work, 2026-08-11

Everything from the Claude Code sessions on `feat/location-acting-actions`,
exported for pickup in Codex. Four documents; read them in this order.

| # | file | what it is | read it when |
|---|---|---|---|
| 1 | `HANDOFF-voice-agent.md` | Branch state, architecture, 6 fixes shipped, **13 audit findings still unfixed**, runbook, standing constraints | Before touching any code |
| 2 | `HANDOFF-session-log.md` | How the conclusions were reached — 5 failed live attempts, 6 mistakes and their general lessons, deliberate reversals | Before changing a design decision |
| 3 | `HANDOFF-memory-export.md` | 18 cross-session memories verbatim — user preferences, project constraints, environment | Before assuming anything about how the user wants work done |
| 4 | `.codex/` (already in repo) | The repo's own skill/workflow definitions, read by `codex-bridge` | Routing a task to the right owner skill |

## The 60-second version

**Goal:** "share my location with Abdul for 15 minutes", spoken hands-free from
any screen, works end to end.

**Status:** not yet verified working. 22 commits, all green, none pushed. Five
live attempts, five different failures, all diagnosed and fixed — the last two
fixes are unverified against a real session.

**The single most important architectural fact:** a navigate-then-act journey is
two tool calls, and *neither of them returns the action's result*.
`start_app_goal` returns `navigation_started`; `continue_app_goal` returns
`preview_started`; the real outcome arrives only as a browser **settlement**.
Three separate bugs on this branch came from getting this wrong.

**The most consequential bug found:** settlements were being discarded for 142
of 144 actions, because making voice hands-free removed the confirmation that
minted the receipt the ledger requires to close them. The action ran; One was
never told. Failures settled fine — only successes vanished. Fixed in
`ffa25af77`, unverified live.

## Resume point — literal state as of handoff

```
worktree   c:\Users\parth\vscode\hushh-voice-bugfix   (NOT c:\Users\parth\vscode\hushh)
branch     feat/location-acting-actions
HEAD       ffa25af77   "fix(voice): stop discarding the outcome of nearly every action"
ahead of   upstream/main by 22 commits, none pushed
tree       clean except these four HANDOFF-*.md files (untracked, deliberately not committed)
backend    RUNNING on :8000, healthy — but started BEFORE ffa25af77 landed,
           so it does NOT have the settlement fix loaded. Cold restart first.
frontend   dev server state unknown; restart if the voice bar misbehaves
```

**The next action is a cold backend restart followed by the live pass below.**
Nothing else on the open list should move until that sequence is observed once —
the last three commits (`cb7d38994`, `fd4a3b3fc`, `ffa25af77`) are entirely
unverified against a real voice session, and two of them changed the trust
boundary.

### Routing this into Codex

`one-voice-governance` owns the surfaces this branch touches
(`consent-protocol/hushh_mcp/one_adk`, `api/routes/one/adk_live.py`,
`contracts/kai`, `hushh-webapp/lib/voice`):

```bash
./bin/hushh codex route-task one-voice-governance
```

**Two files on this branch are NOT owned by any codex skill** — check before
assuming the routed briefing covers them:

- `consent-protocol/hushh_mcp/services/action_directive_ledger.py` (the
  `settle_direct` addition — this is the trust boundary)
- `hushh-webapp/app/one/location/` (the surface contract and all four handlers)

### Paste this into Codex to resume

> Continue the One voice agent work on branch `feat/location-acting-actions` in
> the worktree `c:\Users\parth\vscode\hushh-voice-bugfix`. Read
> `HANDOFF-README.md`, then `HANDOFF-voice-agent.md`, then
> `HANDOFF-session-log.md` before touching code.
>
> The immediate task: cold restart the backend and run the live pass for
> "share my location with <name> for 15 minutes" spoken from a screen other
> than `/one/location`. The last three commits are unverified against a real
> session. Watch `.backend-run.log` for the beat sequence in the README and
> report which beat drops it if it fails.
>
> Do not push. Do not restart the backend while someone is testing — ask first.
> Commit with `git commit -s`, no AI attribution of any kind.

## First thing to do

Cold restart the backend and run the live pass. Nothing else on the open list
matters until this sequence is observed:

```
navigation_started
  → action=location.open_now status=succeeded
  → awaiting_destination_context screen=one_location
  → continuation_nudge_sent
  → action=location.select_share_recipient status=succeeded   ← matched name in summary
  → One asks, naming the MATCHED contact
  → yes → location.share_selected → lands on Active shares
```

Watch it with:

```bash
tail -f .backend-run.log | grep -E --line-buffered \
  "one_adk_goal_decision|one_adk_action_decision|one_adk_live_action_settled|\
one_adk_live_directive_issued|authority_rejected|Connection lost|Traceback"
```

If it breaks, the log now names which beat dropped it — that was not true this
morning, and adding it is what made the last two bugs findable at all.

## Non-negotiables

- DCO signoff (`git commit -s`). **No AI attribution** — no `Co-Authored-By`, no
  "Generated with …".
- **Never push or close a PR without asking**, every time.
- **Ask before restarting the backend** if anyone is testing.
- `contracts/` is generated. Regenerate in dependency order, only after merging
  main. Never hand-edit.
- Push to `upstream` (hushh-labs). The `origin` fork is abandoned.
- Changes must stay iOS/Capacitor compatible — this ships to TestFlight from
  main.

## Caveats on these documents

Written from a session that was compacted twice, so the earliest work is
reconstructed from commits and the full transcript rather than from live
context. Line numbers drift — the audits' numbers were already stale by the time
they were written, because the tree moved underneath them. **Re-grep before
trusting any file:line citation here.** Claims marked CONFIRMED were traced on
both sides of a seam; SUSPECTED ones were not.
