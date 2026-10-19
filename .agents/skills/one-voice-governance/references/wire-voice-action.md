Read the owning One Voice skill before applying this reference.

# Wire a functional voice action

Navigation is mechanical because every navigation action does the same one
thing (`router.push`). A functional action can do five structurally different
things, and the gateway JSON's `execution_target.path` field alone does not
tell you which — the *real* dispatcher (`run_app_action` in
`consent-protocol/hushh_mcp/one_adk/action_tools.py`) decides via separate
Python-side allowlists, independent of the JSON. Get the branch wrong and the
action either does nothing (falls through every case, returns
`action_unavailable`/`voice_tool_not_available`) or does the right thing
without the safety behavior you assumed the JSON gave it for free.

Written from tracing `analysis.start` / `analysis.resume_active` /
`analysis.cancel_active` and the `location.*`/`connect.*` backend-direct
actions end to end, 2026-09. Companion to `wire-voice-navigation` — that
skill's Step 0 is where an action ends up on this skill's plate in the first
place.

## Before anything: does the capability already exist?

This skill wires an action onto a capability. It does not build the
capability. If there is no existing frontend service method or backend
service method that actually performs the mutation/read yet, that is real
engineering — design it like any other feature, then come back here to wire
the voice surface onto it. Do not let "the skill said add an action" become
an excuse to bolt voice onto a half-built capability.

## Step 1 — pick the dispatch path

Walk this in order; stop at the first `yes`.

**1. Does this need a specialist sub-agent's judgment, not a direct
mutation?** (Location reasoning, a domain agent that plans multi-step work.)
→ It's a delegate. Set `delegate_agent_id` on the contract action and add an
entry to `_DELEGATE_TOOL_BY_AGENT_ID` in `action_tools.py` (e.g.
`agent_location → ask_location_agent`) if one doesn't exist for that agent
yet. `run_app_action` refuses and redirects the model to call the specialist
tool directly — the contract action_id itself is never the thing that runs.

**2. Can this mutate/read through the backend service layer with no browser
round trip at all?** — the same criteria the existing set was built on
(`BACKEND_DIRECT_ACTION_IDS`, `action_tools.py:300-329`, comment worth
reading verbatim): *no client-only secret* (nothing that needs live-coordinate
encryption or other client-held key material) and *no editable draft state*
(nothing a person picks, reviews, and reconsiders before confirming — that
belongs on screen, not decided blind in one spoken turn). Portfolio/holdings
reads and most direct mutations (leave a circle, remove a connection, approve
a request) qualify; anything with a multi-field draft (editing an advisor
package, composing a message) does not.
→ Add the action_id to `BACKEND_DIRECT_ACTION_IDS`, implement
`_execute_backend_direct_mutation`'s branch calling the same service class
the REST endpoint already calls (or a new method on it, if the capability is
new). `execution_target.path: "voice_tool"`.
  - If the action has *no* local handler anywhere in the frontend (nothing on
    screen could ever run a parked directive for it — see
    `BACKEND_DIRECT_VERBAL_CONFIRMATION_IDS` for the pattern), a spoken "yes"
    has to be the confirmation gate itself, not a browser card. Model asks,
    hears a real yes, calls again with `confirmed: true` in slots.
  - If it's backend-direct only when a specific slot is present (e.g. a
    person was actually named, vs. "whatever's selected in the composer" —
    see `BACKEND_DIRECT_WHEN_PERSON_NAMED_ACTION_IDS`), write that
    conditional explicitly; don't assume all-or-nothing.
  - `_is_backend_direct()` is the one predicate every eligibility check must
    agree on — if you add a new backend-direct action, nothing else needs to
    change here; this predicate is already the single source of truth three
    call sites share.

**3. Is the actual work already done by something on screen when a person
taps a button?** (Opens a dialog, calls an existing frontend service that
itself talks to the backend, mutates local component state.)
→ `local_handler`. Register it with
`useLocalOnboardingActionHandler(actionId, handler)` in the component that
already owns the tap handler — do not write a parallel implementation, call
the same function the tap does. `execution_target.path: "local_handler"`.
This is also what `"control"` means (a directly-tapped UI control, same
dispatch, different label) — prefer `"local_handler"` for new work; `"control"`
was, once, silently accepted-but-unrouted for a stretch (#6122, an omission
from the accepted-path union), and there's no upside to the separate label.

**4. Is this just "navigate somewhere via a name a frontend command
dispatcher already recognises"** (`"analyze"`, `"import"`, `"history"`,
`"dashboard"`, `"home"`, `"profile"`, `"consent"`)?
→ `kai_command`, resolved by `executeKaiCommand` in
`hushh-webapp/lib/kai/command-executor.ts` — a plain string switch, every
branch a `router.push`, no fetch calls anywhere in it. This is really
navigation wearing an action's clothes (`analysis.start`'s "analyze" command
just routes to the analysis preview; the actual backend analysis call happens
inside that page's own existing data-fetching, same as a tap would trigger).
Only reach for this if you're extending an existing named command's
behavior — inventing a brand new one for a single action is very likely a
sign you wanted `local_handler` or `voice_tool` instead.

If none of these fit, stop and ask a person — don't force it into the closest
option. A wrong dispatch path either silently no-ops (falls through
`executeAgentGatewayAction`'s branches to `blocked: "voice_tool_not_available"`)
or runs through a path whose guarantees don't match what the action actually
needs.

## Step 2 — pick execution_policy, honestly

| Policy | What actually happens |
| --- | --- |
| `allow_direct` | Dispatches the moment guards pass. **No confirmation card by default, even for a mutation** — this surprises people, see below. |
| `confirm_required` | Does **not** auto-raise a confirmation card. `needsConfirmation` is computed as `trusted_activation OR (person's own tap-confirmation setting AND confirm_required)` (`action_tools.py`'s `_directive_flags`, quoting the code directly: *"Voice does not ask by default... confirm_required no longer raises a card on its own... Product owner's call."*) — it only raises a card if the *person* opted into requiring taps for confirmation, as a personal setting. If you need a hard, always-on confirmation regardless of that setting, you don't get it from this policy value alone. |
| `manual_only` | Hard-blocked on both sides, always. One can explain where to go, never perform it. Use for anything that must stay a deliberate human tap no matter what (sign-out, delete-account style actions). |

If an action is `allow_direct` but genuinely needs a guaranteed confirmation
step regardless of anyone's settings (irreversible, no undo — removing a
connection, deleting a circle), don't rely on `execution_policy` for it.
Either set `activation_policy: "trusted_activation_required"` (forces a card,
originally built for provider-popup gestures but usable wherever "definitely
show a card" is the requirement) or hand-roll a two-step gate the way
`connect.remove_connection` does: the handler raises a "needs confirmation"
signal carrying the question to ask, the model asks it and waits for a real
yes, then calls again with `confirmed: true`. `guard_ids` entries named
`explicit_user_confirmation` / `manual_user_execution` are **inert** —
descriptive strings only, not enforced anywhere. Do not rely on adding one to
get confirmation behavior; it does nothing on its own.

## Step 3 — guard_ids: registered is not the same as enforced

Every `guard_id` you write must be a key in
`contracts/kai/capability-guard-coverage.v1.json` — `generate-kai-action-gateway.mjs`
(`build:voice-gateway`, already in CI) hard-fails the build otherwise, so a
typo'd or made-up guard string is caught immediately. That file also
classifies each guard as `"kind": "projection"` (should be checkable
client-side, no server round trip needed) or `"kind": "server_only"`
(the client can never know; don't try).

**Registration is not enforcement — verify separately, don't assume.**
`evaluateKaiActionAvailability` (`hushh-webapp/lib/voice/kai-action-gateway.ts`)
is the actual client-side enforcer, and it only branches on a subset of the
guards the registry calls "projection": confirmed wired today are
`auth_signed_in` / `auth_required`, `vault_unlocked`, `portfolio_required`,
`analysis_idle_required`, `active_analysis_required`, `gmail_connected`,
`gmail_configured`, `ria_persona_available`. **#6437**: two other
registry-declared "projection" guards (`consent_center_available`,
`ria_onboarding_complete`) turned out to be checked *nowhere* — not this
function, not the backend — while gating real, voice-executable RIA actions.
Registering a guard and believing it's therefore live is exactly the trap
that produced that bug. `__tests__/voice/capability-guard-coverage.test.ts`
now exercises every registered "projection" guard's actual blocking
behavior (not just its presence as a string) and fails loudly — as a visible
`.todo`, not a silent skip — for any guard that doesn't yet have a proven
way to block. If you add a "projection" guard, add its passing/failing
`AppRuntimeState` override to that test in the same change, or the test
itself will tell you to.

For a `"server_only"` guard: there is no generic backend dispatch table
keyed by the guard_id string or its declared `validator` name — that name in
the registry is a label for where enforcement is expected to live, not a
function to go find. You have to write the actual check into whatever
backend code path the action reaches (the RIA/consent/relationship service
methods, typically), the same way you'd add any other authorization check to
that endpoint. Adding the guard_id to the JSON alone enforces nothing.

`guard_ids` named `explicit_user_confirmation` / `manual_user_execution`
specifically: read `_directive_flags` in `action_tools.py` before assuming
these gate anything — as of this writing they feed the confirmation-card
*display* decision (see Step 2), not a hard block on their own.

The backend's `run_app_action` does not re-check the client's guard set
either way — its own comment is explicit: *"the app re-checks guards before
executing."* It enforces a different thing: `manual_only`/`unwired`
refusal, voice-domain toggles, screen reachability (does the scope even
claim this screen), delegate redirection, and turn-scoped
already-completed/already-failed dedup. Client guards, the "server_only"
domain checks, and the backend's own dispatch-time checks are three
separate things that happen to share some vocabulary — a guard that only
exists in one of them is bypassable by anything that reaches the others
directly.

## Step 4 — regenerate + verify

Same three-artifact regeneration as navigation actions
(`wire-voice-navigation` Step 3), plus:

```bash
cd hushh-webapp
npx vitest run __tests__/voice/kai-action-gateway.test.ts __tests__/voice/capability-guard-coverage.test.ts
cd ..
consent-protocol/.venv/Scripts/python.exe -m pytest consent-protocol/tests/test_one_adk_agent_tree.py -q
```

For a `voice_tool`/backend-direct action specifically, also write a backend
test exercising `run_app_action` (or the service method directly) for: guard
denial, the confirmation round-trip if you built one, and the actual mutation
outcome. The frontend dead-end-reachability test only proves the action is
*reachable*, not that its backend behavior is correct — that's on you.

## Worked examples to read, not just this file

- `analysis.start` / `analysis.resume_active` / `analysis.cancel_active`
  (`app/one/kai/analysis/page.voice-action-contract.json` +
  `action_tools.py`) — one action per dispatch path (`kai_command`,
  directive-parked `voice_tool` with a mounted local handler, `manual_only`
  cancel) inside a single feature, useful for seeing all three differ.
- `connect.remove_connection` — the hand-rolled two-step confirmation gate on
  an otherwise `allow_direct` backend-direct action.
- `location.leave_circle` / `location.delete_circle` (commit `09d91f47d`) —
  a real "add a backend-direct action" PR: what changed was two lines in
  `BACKEND_DIRECT_ACTION_IDS` plus porting the frontend's spoken-name fuzzy
  matcher to Python (`spoken_name_resolver.py`) — no new REST endpoint, same
  service class the tap-driven UI already used.
