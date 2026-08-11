# Handoff — session log and diagnostic chronology

The reasoning that produced `feat/location-acting-actions`, including the wrong
turns. Commit messages carry the conclusions; this carries how they were
reached, which is the expensive part to re-derive.

Companion to `HANDOFF-voice-agent.md` (state) and `HANDOFF-memory-export.md`
(cross-session memory).

---

## Origin

The branch began as four scoped phases:

1. Low-risk acting actions for Location (`pause_updates`, `resume_updates`)
2. Duration-slotted share with a tapped recipient (`share_selected`)
3. Relax the single-step/multi-step chain
4. Name → userId resolution

Phase 3 was investigated and **deliberately not done**. `continue_app_goal` is a
fixed two-beat machine — `step_cursor` 0 navigates, `>= 1` returns
`preview_already_open`. There is no loop over `workflow_steps`. A true N-step
executor is a rewrite, not a relaxed length check, and nothing on this branch
needed one. Do not "finish" phase 3 without deciding to build that executor.

Phase 4 shipped in a form opposite to how it was scoped — see "Reversals" below.

---

## What the user asked for, in order

Each of these changed the design, so they are worth reading as a sequence:

1. *"got confirmation to make voice totally hands-free, no confirmation needed
   from the user, if you really need confirmation then take it verbally"*
2. *"the hands-free mode should show the task it did, like open the page where i
   could see that task being done"*
3. *"we still asking this?"* — screenshot of a confirmation card on a low-risk
   action, after I had scoped the change to only the 10 `confirm_required`
   actions. The screenshot was correct and my scoping was wrong: I had described
   the *contract*, while the *runtime* hardcoded `needsConfirmation = true`.
4. *"look there is no authorisation needed now, voice can do anything and
   everything as far as scope is concerned"*
5. *"basically if i say to share my location with sarah for 60 mins, it should
   ask once so that i know it got the name right, and then just performs the
   action"* — **the pivotal one.** It reframed the question from authorization to
   parse-verification, which dissolved the constraint that had kept recipient
   names out of voice entirely.
6. *"remove the constraint that a certain task can be done from a certain page
   only — if i ask for a task which belongs to a different page, take me to that
   page and start that task right away"*
7. *"i think then navigate first then ask"* — chosen after I explained that
   resolving the name without navigating needs architecture that does not exist
   (the resolver lives in the page component; lifting it to a globally-mounted
   host would also inherit the `location/state` latency problem).

---

## Deliberate reversals — do not undo these

**Phase 4 kept contact names out of the model's context. `e0e711a2a` put one
back.** Hearing "Sarah Chen" read aloud *is* the safety mechanism; a question
that names nobody catches nothing. The name still never crosses the boundary as
a user id — the browser matches against the list it already holds, and
`sanitize_live_context` strips `selected_entity`/`primary_entity` server-side
because surfaces fill them with real names and emails.

**`select_share_recipient` is escorted, `share_selected` is not.** Selecting
sends nothing, so walking to Location and doing it is safe. Sharing transmits,
so arriving and firing at whoever is still selected is exactly what must not
happen.

---

## Diagnostic chronology — 2026-08-11 live testing

Five attempts, none of which completed the flow. Each failed for a different
reason, and the sequence is instructive because **four of the five looked like
the same symptom from the outside** ("voice isn't doing anything").

### Attempt 1 — "which Sarah do you mean?", asked from the wrong screen
One asked a disambiguation question while the person was still on `/one`, using
the name it had *heard*, with no Location screen visible.

**Diagnosis: the model invented the question.** The instruction claimed
`start_app_goal`'s result "tells you who the app MATCHED". It does not — it
returns `navigation_started`. With no match in hand, One filled the silence with
the person's own word.

This produced the "navigate first, then ask" design and, underneath it, the
discovery that the journey continuation note was hardcoded to Analysis
(`a1bf517c7`) — so no Location journey could ever have continued anyway.

### Attempt 2 — "i just said the prompt but its just listening"
**Not a voice bug.** The log's last lines:
`Connection lost (1011 ... Input data processing failed ...)` then
`Attempting to reconnect`. The mic was open with no model behind the socket.

Underneath: `/api/kai/market/insights/baseline/…` took **107 s**,
`/api/one/location/state` 31–34 s, `/api/consent/center/summary` 33 s. The page
was too saturated to publish a fresh context, and the relay will not act without
one. Known deferred DB issue — see the memory export.

### Attempt 3 — "it can't share my location with abdul, when he is in my connections"
The log showed **no directive, no goal decision, nothing** — One refused
conversationally without calling a tool.

Two causes, both in prose: the general rule *"do not offer actions from another
screen"* (navigation had a carve-out, journeys never got one), and nothing
telling One that **not recognising a name is expected** — it holds no contact
list by design, so it refused on behalf of a list it has never been allowed to
see. Fixed in `cb7d38994`.

### Attempt 4 — `input_needed slot=person`, twice
Progress: One called `start_app_goal` instead of refusing. But without the
`person` slot, so the journey stopped before navigating and One asked "who do
you want to share with?" at someone who had just said Abdul.

**Both faults were mine, in prose written an hour earlier.** I never wrote the
slot key (`analysis.start` has always spelled out `slots {'symbol': <ticker>}`),
and I placed *"you do not know who they named and you are not meant to"*
directly before *"call it with the name you heard"*, which reads as *don't pass
the name*. Fixed in `fd4a3b3fc` with a test that now asserts literal slot syntax
for every action the instruction names.

**This attempt was only diagnosable because `cb7d38994` had just added logging
to `start_app_goal`'s early returns.** Before that, all three refusal paths
returned silently and "One never tried" was indistinguishable from "One tried
and was turned away" — both an empty log.

### Attempt 5 — never ran; the audits found why it could not have worked
Two confirmed defects meant the share was impossible regardless of the chain:
the send action was **not in the model's inventory** (cap applied before
ranking), and if it had run, its success would have been **discarded** (no
receipt → settlement dropped). Both fixed in `ffa25af77`, both unverified live.

---

## Mistakes I made, and the general lesson from each

Recorded because the same shapes will recur.

1. **Half-changed a two-sided contract.** Changed `needsConfirmation` in
   `agent-bar.tsx` after reading only the frontend; `action_tools.py` had the
   same hardcoded `True`. Actions ran and the relay rejected their settlements.
   Fixed by reverting and changing both halves together (`f777a14e9` →
   `1a0f9f262`).
   **Then made the same class of error again**, one level deeper: `8a247ef28`
   made both sides agree nothing needs confirming, but the *ledger* is a third
   side, and it still demanded a receipt. That is finding #1 of the audits.
   **Lesson: count the sides. The comment in `action_tools.py` calling these
   "ONE invariant expressed on both sides" is itself wrong.**

2. **A fix that passed every test and did nothing.** `ce15e6948` reordered
   `LOCATION_VOICE_ACTIONS` to protect local handlers from the context cap. The
   cap actually bites on `publishedActionIds`, which puts `controls` first — a
   different array. Inert for a week, tests green throughout.
   **Lesson: verify the fix reaches the code path, not just that the tests pass.**

3. **Wrote a claim about a tool without reading the tool.** "Its result tells
   you who the app MATCHED" — it does not. Prose is untested, so a false claim
   there survives every check.
   **Lesson: instruction prose is code with no compiler. Verify each factual
   claim against the implementation before writing it.**

4. **`routeAfter`/`screenAfter` misread as instructions.** They are expectations
   `settleAgentGatewayAction` waits on; returned by a non-navigating action they
   time out into a false "started".

5. **Nearly cleared a ref before the effect that reads it.** Caught mid-edit;
   fixed by threading the destination as a `handleShare` argument instead, which
   also removed a staleness leak.

6. **Restarted the backend four times while the user was mid-test.** Each one
   throws ~11.6 s `asyncpg` connect timeouts at whatever page is open (Cloud SQL
   is cross-continent; the pool has to rebuild). Correct behaviour is to **ask
   first**, not announce-and-proceed.

---

## Things that looked like bugs and were not

- OpenTelemetry `GeneratorExit` → `ValueError: Token created in a different
  Context` on socket close.
- `ClientDisconnected` stack traces on browser disconnect — real, but cosmetic;
  worth fixing only because the noise buries genuine errors.
- The `manual_only` branch appearing dead (the contract has no `risk` object) —
  `action_gateway._normalize` synthesizes it.
- `_DELEGATE_TOOL_BY_AGENT_ID` appearing to bounce product actions to
  specialists — only 5 `*.chat.turn` pseudo-actions carry a mapped delegate id.
- `sos-panel.test.tsx` and `test_kai_voice_tools::test_transcript_tab` — both
  pre-existing failures, neither in this diff.

---

## Working agreement that was in force

The user's second Claude session does architecture and planning; this session
executed surgically and stopped on ambiguity rather than guessing. Two
permission-classifier denials (a `git push`, an `agent-bar.tsx` edit) were
respected and explained rather than worked around.

The user runs all live testing themselves — every "give me tests" produced a
manual test plan, not an automated run. Test plans A–E, F–H (verbal
confirmation) and L–P (named-share chain) were written and **never executed**.
