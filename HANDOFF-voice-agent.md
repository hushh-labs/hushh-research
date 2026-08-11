# Handoff — One voice agent, `feat/location-acting-actions`

Written 2026-08-11 for whoever picks this up next (Codex). Everything below is
verified against the working tree at commit `ffa25af77` unless it says
SUSPECTED. Where a claim is inferred rather than read, it says so.

- **Worktree:** `c:\Users\parth\vscode\hushh-voice-bugfix` (a git worktree, NOT
  the primary `c:\Users\parth\vscode\hushh` checkout)
- **Branch:** `feat/location-acting-actions`, cut from `upstream/main`
- **22 commits, none pushed.** Push target is `upstream` (hushh-labs). The
  `origin` fork is abandoned.
- **Status:** all green — 182 webapp voice tests, 103 Python tests, `tsc`,
  `ruff`, `eslint`. One pre-existing unrelated failure: `test_kai_voice_tools.py
  ::TestKaiOpenHistory::test_transcript_tab` (asserts `transcript`, component
  says `history`) — confirmed pre-existing by stashing.

---

## 1. What this branch set out to do

Give Location voice actions that **act** rather than only navigate, and make
"share my location with <name> for 15 minutes" work hands-free from any screen.

Four new actions on `/one/location`:

| action | policy | risk | notes |
|---|---|---|---|
| `location.pause_updates` | `allow_direct` | low | escorted (has `settlement_target`) |
| `location.resume_updates` | `confirm_required` | medium | escorted |
| `location.select_share_recipient` | `allow_direct` | low | escorted; `person` slot |
| `location.share_selected` | `confirm_required` | high | **deliberately NOT escorted** |

The asymmetry is the safety argument and should not be "tidied up":

- Pausing can only ever reduce what others see; resuming makes you visible again
  to every active grant, so it is looked at.
- Selecting someone is visible and reversible — a misheard name becomes a wrong
  face on screen, in front of someone who can see it. Nothing leaves the device.
- Sharing is the only one that transmits. It has no `settlement_target` on
  purpose: escorting it would mean One walking to Location and firing the
  composer at whoever happened to still be selected in it.
- The `person` slot carries **the spoken name only, never a user id**. Matching
  happens in the browser against the list it already holds, because
  `sanitize_live_context` strips `selected_entity`/`primary_entity` server-side
  (surfaces fill them with real names and emails).

Tests pinning all of this: `hushh-webapp/__tests__/voice/location-acting-actions.test.ts`.

---

## 2. Architecture you need before touching anything

### Two journey shapes, discriminated by step count

- **`_settled_journey_definition`** — `len(steps) >= 2`, `[action, choice]`.
  Run here, then choose where it lands. Only `onboarding.claim_one` today.
- **`_navigation_journey_definition`** — `len(steps) == 1` plus a
  `settlement_target`. Navigate to the destination FIRST, run the action there.
  15 actions today.

Both live in `consent-protocol/hushh_mcp/one_adk/action_tools.py`. The step
count is the only discriminator — do not "simplify" it.

### A navigate-then-act journey is TWO tool calls

This is the single most important thing to understand, and getting it wrong
caused three separate bugs on this branch:

1. `start_app_goal` issues the **route** step and returns `navigation_started`.
   **It does not return the action's result — the action has not run.**
2. The relay sends a goal-runner note when the destination screen lands
   (`_GOAL_CONTINUATION_NOTE` in `adk_live.py`).
3. `continue_app_goal` issues the **action** step and returns `preview_started`.
   **It does not return the result either.**
4. The result arrives **only** as a browser settlement, injected as
   `[App action settlement - not user speech] ... Summary: <summary>`.

So the matched contact name reaches One in exactly one place: the settlement
report for `location.select_share_recipient`. Anything that asks a question
before that is improvising.

### `routeAfter` / `screenAfter` do not navigate

They are expectations `settleAgentGatewayAction` **waits on**. Returned by a
non-navigating action they time out into a false "started".

### Generator order (regenerate AFTER merging main, never before)

```
npm run build:voice-gateway
node ./scripts/architecture/generate-surface-map.mjs
npm run build:route-orchestration-index
python scripts/ops/generate_runtime_topology_index.py   # from repo root
```

Everything under `contracts/` is **generated**. Never hand-edit. Sources are the
colocated `*.voice-action-contract.json` files. Gateway currently holds **144
actions across 36 surfaces**.

---

## 3. Bugs fixed on this branch, and what each one teaches

Ordered by how much they'd cost to rediscover.

### `ffa25af77` — settlements were discarded for 142 of 144 actions
The load-bearing one. The ledger closes a settlement by matching the receipt
minted at confirmation and requires `state = 'consumed'`. Hands-free voice
collapsed `needs_confirmation` to `activation_policy == trusted_activation_required`
— 2 of 144 actions — so 142 raise no card, mint no receipt, never leave
`'issued'`, and their settlements hit `raise ActionDirectiveAuthorityError`.

The action ran; One was never told; One's instruction forbids claiming success
without a settlement. **Failures settled fine** (they take the `cancel_voice`
branch) — only successes vanished. That asymmetry is the fingerprint.

Fixed with `ActionDirectiveStore.settle_direct`: same binding as the confirmed
path minus the gesture, `state = 'issued'` so it closes exactly once.
`issued_direct_run_directives` records at ISSUE time from the payload the relay
parked — **do not** move that to read the settling frame, that would let the
browser rule on its own authority.

**Lesson:** the trust boundary has THREE sides, not two — relay policy, browser
gate, and the ledger. A comment in `action_tools.py` calls them "ONE invariant
expressed on both sides"; it undercounts by one. Change all three together.

### `a1bf517c7` — the journey continuation note was hardcoded to Analysis
Gated on the literal `goal.analysis.start_debate` + screen `kai_analysis`, so
every journey authored afterwards navigated and then silently stopped. The route
settles either way, so the log looked identical to success. Now reads the
destination off the goal run's `expected_screen`.

### `ffa25af77` (part 2) — inventory truncated before the ranking that protects it
`publishedActionIds` was capped at 10 (`STRUCTURED_CONTEXT_ARRAY_CAP`) **before**
`prioritizeAvailableActionIds` ran. Location publishes 18 controls whose first
ten all open a tab, so `share_selected`, `select_share_recipient` and
`pause_updates` were invisible to the model **on Location itself**, and every
acting request returned `action_unavailable`. The dev warning naming what was
lost could never fire, because the list arrived pre-truncated.

**Lesson:** an earlier fix for this (`ce15e6948`) reordered `LOCATION_VOICE_ACTIONS`
in `page.tsx` and was **inert** — the cap bites on `publishedActionIds`, which
puts `controls` first. Check which array actually reaches the cap.

### `cb7d38994` — refusing an action because the person is elsewhere
The general instruction said "do not offer actions from another screen" while
the escort machinery existed precisely to make that work. One refused
conversationally without calling any tool. Also: One holds no contact list by
design, and nothing told it that **not recognising a name is expected** rather
than grounds to decline.

### `fd4a3b3fc` — the slot key was never named
The instruction said "call it with the name you heard" and never wrote
`{'person': ...}`. The model guessed wrong, `start_app_goal` returned
`input_needed slot=person`, and One asked "who do you want to share with?" at
someone who had just said the name. `analysis.start` has always spelled out
`slots {'symbol': <ticker>}`.

**Lesson:** every required slot One is told to fill must appear as literal slot
syntax. There is now a test asserting exactly that
(`TestNamedShareChain::test_every_required_slot_one_must_fill_is_spelled_out`).

### `57c1b75bf` — the greeting hold was charged twice
The cue is armed twice (generic at socket open, screen-aware when context
lands). Re-arming restarted the 1.5 s wait, timed from context arrival. The hold
exists to stop One talking over someone who opened the mic already speaking —
that is owed once. Now on `_InitialGreetingGate.hold_seconds`.

---

## 4. UNFIXED — 13 audit findings, ranked

Three read-only audits swept the voice runtime on 2026-08-11. All CONFIRMED
items were traced on both sides. **Line numbers drift — re-grep before trusting.**

### High

1. **`_continue_settled_journey` has five outcomes and zero log lines**
   (`action_tools.py`, the `_continue_settled_journey` body). Three of the five
   destroy the goal run. `onboarding.claim_one` is the only settled journey, so
   "claim One with Google" abandoning itself mid-flight produces a completely
   empty relay log. Two of the three abandonment paths also return the identical
   string `journey_interrupted`. This is the exact gap `cb7d38994` closed in
   `start_app_goal`, one function away, untouched.

2. **A mid-call consent-token refresh wipes the relay's live screen context.**
   `gemini-live-client.ts::updateConsentToken` sends `sendAppContext({})` — a
   partial frame — and the relay treats **every** `app_context` as a full
   replacement. `sanitize_live_context({consent_token, timezone})` yields
   `screen: None`, `available_action_ids: []`, `signed_in: False`, and **no**
   `context_pending` marker. Fired from `agent-bar.tsx` on sign-in or vault
   unlock during an open call. Effect: the moment the vault unlocks mid-call,
   every non-navigation action starts returning `action_unavailable`, any
   in-flight journey stalls forever, and because `clean_screen` is empty the
   route-note re-injection is skipped so the model is never told. CONFIRMED.

3. **`run_app_action`'s screen guard reads the frozen session state.**
   `current_screen = str(tool_context.state.get(_STATE_SCREEN) ...)`. The
   module's own docstring says `run_live` opens one long invocation per socket
   so `tool_context.state` is frozen at connect time — every other reader
   (`_available_action_ids`, `_context_revision`, `start_app_goal`,
   `continue_app_goal`) uses the live publication. This is the last survivor of
   the old read. Effect: open voice, navigate, ask for something on the new
   screen → inventory check passes (live), reachability check refuses with
   `wrong_screen` telling you to open the screen you are standing on. CONFIRMED.
   Note the existing `wrong_screen` test seeds both `_STATE_SCREEN` and
   `hussh:voice_context`, so it asserts the contract, not the live payload.

4. **Hands-free confirmation needs two spoken yeses.** With no receipt yet,
   `settlePendingConfirmation(true)` only mints the receipt, sets "Tap Run to
   execute", and returns. A second affirmation or a tap is required — while the
   instruction forbids re-asking. The person repeats themselves into silence.
   CONFIRMED by code reading, not reproduced live. (May be moot now that #1's
   fix means most actions never raise a card at all — **verify before fixing**.)

### Medium

5. **`list_intro_navigation_actions` advertises 69 actions, `run_intro_navigation_action`
   accepts 28.** The runner re-narrows with `clean_id.startswith("route.")`,
   the exact prefix test `action_gateway.py` documents at length as wrong (41
   contracts navigate under surface-scoped names like `setup.open_finance`).
   Pre-vault **text** head only, not the voice relay.

6. **Five unlogged refusals in `run_app_action`** — `onboarding.claim_one`,
   `setup.hub_master_ack`, `phone_mandate.submit_*` (all `terminal`), the
   `delegated` redirect, and `kyc.draft.request_redraft` (`input_needed`). Ten
   sibling branches log; these do not. The `request_redraft` one is worst: an
   over-1000-char instruction and an absent one return the identical message,
   so the retry loop is invisible.

7. **`sanitize_action_settlement` collapses five rejection causes into one
   field-less line** (`one_adk_live_invalid_action_settlement`). Junk frame,
   expired directive, and action-id typo are indistinguishable.

8. **A promised confirmation card that never appears and never times out.**
   `except Exception` on `issue()` logs and `continue`s, skipping the
   `clientDirective` send — but `run_app_action` already told the model "the app
   will ask the user to confirm X", so One says it aloud. No card, no directive,
   no gc task, no `ui_timeout`. Dead-ends on a promise.

9. **The microphone can go silent with no trace.** Six consecutive silent
   `continue`s in the realtime-audio path; `_decode_realtime_audio` returns
   `None` for anything over 512 KB decoded or any base64 error. A client that
   buffers a long utterance into one frame produces a dead mic with zero server
   evidence.

10. **`_ONBOARDING_SCREENS` has drifted off the generated index.** `one_setup`
    and `kai_setup_wizard` match nothing in the route orchestration index's 61
    canonical screens; eight real setup surfaces are missing
    (`one_setup_connections`, `one_setup_email`, `one_setup_finance`,
    `one_setup_finance_import`, `one_setup_location`, `one_setup_ria`,
    `one_setup_connected_systems`, `one_setup_gmail`). Effect: a signed-in
    person mid-setup gets the generic greeting instead of the hand-off cue.

### Low

11. **`sanitize_interaction_layer` drops the whole layer silently** on any single
    invalid field. Its sibling `sanitize_dead_end` does log. When it fires, a
    modal is up, the layer vanishes, the blocking-action filter never runs, and
    One offers controls behind a blocking dialog.

12. **Onboarding enums coerce silently** — an unrecognised phase becomes
    `anonymous_auth`, feeding `resolve_onboarding_goal` a wrong journey state
    with nothing to explain it. No drift today; `ONBOARDING_CAPABILITIES` mirrors
    `setup-capability-ids.ts` exactly, but it is a hand-copied mirror with no
    test binding it.

13. **Every `ValueError` in the relay is reported as `unknown_tool_call`** — the
    `try` wraps all of `_pump_live_events()`, so any `ValueError` anywhere ends
    the session with that reason code sent to the browser.

Also: **the relay's crash log is `error.__class__.__name__` only** — a pump
crash, the failure that kills a live call outright, is logged as the bare word
`KeyError`. And **`trusted_activation_required=True` is hardcoded at issue**,
ignoring the contract's 2-of-144 `activation_policy`; harmless today (the relay
always passes `trusted_activation=True` on confirm) but the ledger rows
misrepresent the contract.

### Leads that did NOT pan out — do not re-chase

- `action_tools.py`'s `if action_id.startswith("route.")` in
  `_navigation_journey_definition` — redundant defence, not the gate.
- `_DELEGATE_TOOL_BY_AGENT_ID` silently bouncing product actions — only 5
  `*.chat.turn` pseudo-actions carry a mapped delegate id.
- Settlement status enums and field caps across the TS/Python boundary — verified
  identical.
- The two manifest copies (`contracts/` and `hushh-webapp/contracts/`) — byte
  identical today. Standing drift risk, not a current bug.
- `risk.execution_policy` vs `execution_policy` — `action_gateway._normalize`
  synthesizes `risk`, both readers work.
- `location.share_selected` returning `routeAfter` without navigating — it does
  navigate, via `shareCompletedDestinationRef` and the hub's completion effect.
- `manual_only` branch being dead — it is not; `risk` is synthesized.

---

## 5. Still open, not yet started

1. **Live pass never completed.** "share my location with <name> for 15 mins"
   from a non-Location screen has not once run end to end. Expected sequence in
   the log: `navigation_started` → `action=location.open_now status=succeeded` →
   `awaiting_destination_context screen=one_location` →
   `continuation_nudge_sent` → `action=location.select_share_recipient
   status=succeeded` with the matched name in the summary → **then** One asks.
   The last three fixes are unverified against a real session.
2. **Generalise the escort** — a generator default in
   `createDefaultGoalWorkflowSteps` giving every single-route `local_handler` a
   `settlement_target`, plus an `"escortable": false` opt-out.
3. **Audit the 52 non-route wired actions** auto-escort would cover. Proposed
   BLOCK list: `location.share_selected`, `phone_mandate.submit_code`,
   `phone_mandate.submit_number`, `analysis.cancel_active`,
   `analysis.confirm_preview`, `kyc.draft.request_redraft`,
   `setup.hub_master_ack`. Three groups unresolved: the `setup.finish_*`/
   `setup.skip_*` group (11 actions, already journeys), `onboarding.claim_one`,
   `kai.setup.launch_dashboard`.
4. **Push.** 22 commits, none pushed. Requires explicit go-ahead per instance.

---

## 6. Runbook

### Backend
```bash
cd consent-protocol
./.venv/Scripts/python.exe server.py > ../.backend-run.log 2>&1
```
Comes up in ~5–13 s; look for `Application startup complete`. Health:
`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/` → 200.

**Always cold restart** to pick up backend changes — no supervisor-respawn
shortcut. Prompt/instruction changes in `agent_tree.py` need it too.

**Ask before restarting if someone is testing.** Every restart throws ~11.6 s
`asyncpg` connect `TimeoutError`s (500s on `/api/account/identity/refresh`,
`/api/iam/persona`) at whatever page is open, then recovers. See DB note below.

### Tests
```bash
# Python
cd consent-protocol
./.venv/Scripts/python.exe -m pytest tests/test_one_adk_live_protocol.py tests/test_one_adk_agent_tree.py -q
./.venv/Scripts/python.exe -m ruff check <files>

# Webapp
cd hushh-webapp
npx vitest run __tests__/voice --reporter=dot
npx tsc --noEmit
npx eslint <file> --max-warnings=0
```
Note `tests/test_deploy_sha_gate_payload_size.py` has a collection error
unrelated to this work; `--ignore` it when running the whole suite.

### Watching a live voice session
```bash
tail -f .backend-run.log | grep -E --line-buffered \
  "one_adk_goal_decision|one_adk_action_decision|one_adk_live_action_settled|\
one_adk_live_directive_issued|authority_rejected|Connection lost|Traceback|CRITICAL:"
```

### Database — Cloud SQL, not Supabase
`consent-protocol/.env`:
```
CLOUDSQL_INSTANCE_CONNECTION_NAME=hushh-pda-uat:us-central1:hushh-uat-pg
DB_HOST=127.0.0.1   DB_PORT=6543   # auth proxy
```
UAT project (`hushh-pda-uat`) is the default for all dev/local work — never
`hushh-pda` (prod) without explicit instruction. Supabase survives only in
`.env.example`.

Every query is a round trip India → **us-central1**. `/api/one/location/state`
issues 26 queries against a budget of 4 and takes 31–34 s;
`/api/consent/center/summary` ~77 queries, 33–47 s. **The fix is reducing query
COUNT, not optimizing queries** — the time is RTT. Both fire repeatedly while
One is open and starve everything sharing the pool, including voice tool calls.

**This is explicitly deferred.** Do not proactively fix it. Recognise the
pattern fast — check whether these two are mid-flight before chasing any
"stuck"/timeout/hung symptom — and ask before spending time on it.

---

## 7. Standing constraints — carry these over

- **No AI attribution in commits or PRs.** This repo uses DCO signoff (`git
  commit -s`). Never `Co-Authored-By`, never "Generated with …".
- **Never push or close PRs without a per-instance go-ahead.**
- **Announce disruptive actions first** — killing processes, restarting the app.
  Someone may be mid-session.
- **Everything under `contracts/` is generated.** Regenerate, never hand-edit,
  and only AFTER merging main.
- **All changes must be iOS/Capacitor compatible** — hushh-research ships to
  TestFlight from main. Verify against the native build, not just web. *(Every
  change on this branch so far is backend Python or voice-context TS with no
  native surface, so nothing here has needed a native check — but that ends the
  moment a UI change lands.)*
- **After opening/pushing a PR, drive CI to green.** Never leave it red.
- Push target is `upstream` (hushh-labs). Measure divergence against
  `upstream/main`.

---

## 8. Judgement calls worth preserving

Recorded because they look like bugs and are not:

- **`location.share_selected` has no `settlement_target` on purpose.** Escorting
  it means arriving at the composer and firing it at whoever is still selected.
- **Contact names ARE in the model's context, deliberately.** An earlier design
  kept them out; `e0e711a2a` reversed it, because hearing "Sarah Chen" read back
  *is* the safety mechanism. The name still never crosses as a user id.
- **The one question is parse-verification, not authorization.** It exists to
  catch a mis-heard name. That is why it must use the MATCHED name and must come
  after the pick settles — asking with the heard name catches nothing.
- **The greeting's idle hold is not dead time** — it stops One talking over
  someone who opened the mic already speaking. Shorten it deliberately or not
  at all.

---

## 9. Known-benign noise

- OpenTelemetry `GeneratorExit` → `ValueError: Token ... created in a different
  Context` on WebSocket close.
- `websockets.exceptions.ConnectionClosedOK: received 1005` →
  `uvicorn.protocols.utils.ClientDisconnected` → `ERROR: Exception in ASGI
  application`, three stack traces, whenever the browser disconnects. Harmless
  but **worth fixing** — `_close_quietly` exists for the close path, the
  `send_text` paths have no equivalent guard, and routine disconnects print
  what looks exactly like a crash.
- `sos-panel.test.tsx` failure (`lg:max-w-[820px]` vs component's `720px`) —
  pre-existing, not in this diff.
- `yfinance` 404s for symbols like `K`, Finnhub `403` on `/stock/candle`.
