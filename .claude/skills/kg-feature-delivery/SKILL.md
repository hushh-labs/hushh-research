---
name: kg-feature-delivery
description: Take a knowledge-graph feature prompt (a KG .html plus a long "implement X in One" prompt) from prompt to verified-live-on-UAT in one sitting, automation only. Use whenever Ankit hands over a feature graph and says "do this like we did for Circle / Connect / SMS / Profile". Encodes what actually worked on 2026-09-18..22 — measure the checkout before building, one failing test per graph observation, the repo's own patterns, an honest status vocabulary, and a ship loop that ends at the serving revision's deploy-sha, not at a green workflow.
---

# KG feature delivery

**The graph is a source map of a past commit. Measure the checkout first. Then: one failing
test per real observation, the repo's own pattern, honest statuses, ship by exact SHA, prove
the serving revision. No manual testing. One sitting.**

Every KG prompt so far was partly done already and partly real. Save My Soul was fully merged
before the prompt arrived (PR #6879) — the only work was a bug its own trace doc had flagged.
Profile's four Live tools existed, and all ten of its observations were still true. Building
from the prompt without measuring would have re-done finished work or fixed nothing.

This file is both the procedure and the reasoning behind it. The reasoning is the part that
transfers; the commands are just this repo's spelling of it.

---

## 0. What is actually being asked

> "are ye done kro — just SMS — like how we have done for circle and connect — plan this and
> act on it — don't waste time on manual testing — do automation testing — try to be
> intelligent — time is precious — we can stop you on large testing"

Translate: **own it end to end, be surgical, prove it with automated tests, ship it to UAT,
report with evidence, defer honestly.** Not "write a design", not "ask what to do", not
"build everything in the prompt".

---

# PART ONE — How to pick the work

## 1.1 The stance everything else follows from

**The prompt is evidence about the past. The repository is evidence about now.**

A KG prompt names the commit it traced (`5c15f15`, `4b639370`). That is not HEAD. Between that
commit and now, other people shipped. So the prompt's claims fall into three buckets and you
cannot tell which from reading it:

- already built (do nothing)
- still true (this is the work)
- described but never implemented (this is also the work, but different work)

Reading the prompt harder does not resolve this. Only the checkout does.

## 1.2 Try to make the session unnecessary first

The user said "like how we have done for circle and connect". That phrase implied a pattern
already existed. Combined with the prompt tracing an old SHA, the first move was:

```bash
git checkout main && git fetch --prune origin && git pull --ff-only origin main
git log --oneline -40 | grep -iE "circle|connect|voice|sos|sms|save my soul"
```

Output:

```
f0ab3cce7 Merge pull request #6879 from hushh-labs/feat/one-voice-save-my-soul
93af27cb5 test(voice): held-out Save My Soul tool-selection evaluation
feff3c795 feat(voice): Save My Soul arms on a prepared tap card ...
```

**The entire feature was already merged** — 47 files, 6,094 insertions, the exact four-commit
shape the prompt requested. That one grep converted "implement Save My Soul" into "audit Save
My Soul and fix what's actually wrong". Fifteen seconds; saved most of a day.

Then establish a baseline *before touching anything*:

```bash
cd consent-protocol && .venv/bin/python -m pytest tests/one_voice/... -q     # e.g. 94 passed
cd hushh-webapp   && npx vitest run --reporter=dot <feature suites>          # e.g. 252 passed
gh pr list --state open --base main                                         # who else is in these files?
```

A baseline is what makes "did I break this?" answerable later. It mattered twice:
`__tests__/voice/route-playbook-contract.test.ts` fails on clean `origin/main` and runs in no
CI lane, and `ruff format` reports drift on files nobody touched. Both were proven pre-existing
on a detached worktree off `origin/main`, named in the PR, and left alone.

## 1.3 Triage each observation — do not read the prompt as a plan

The prompt's "turn these into regression tests" section listed ten observations for Profile.
The move is not to implement ten things. It is to open the exact file each one names and
decide: **still true / already fixed / documented-only.**

```bash
# OBS1: "DisplayNameEditor exists but is not mounted in the Account row"
grep -rn "DisplayNameEditor" --include="*.tsx" components app lib \
  | grep -v "__tests__\|display-name-editor.tsx"
# → (no output). Still true.

# OBS3/4: "avatar helpers resolve null while UI reports success"
grep -n "null\|catch\|return" lib/profile/avatar-capture.ts
# → line 40-42: `} catch { return null }` — cancel and plugin failure indistinguishable. Still true.
```

For Profile all ten were still true. For SMS all of it was done except one. **You cannot know
which case you are in without looking, and the two cases need opposite work.**

Write the verdict table into the plan file, with the file:line that proves each row. It becomes
the scope, the PR body, and the final report.

## 1.4 Where the real bugs are: the "known issues" paragraph

The SMS feature was complete and green. The bug was in its own trace doc
(`docs/reference/one/<feature>-voice-trace.md`):

> **Revoke event lane**: `_revoke_grant_transition` reads a `share_kind` column that does not
> exist, so SOS revokes are recorded/pushed as ordinary revokes. Unchanged (existing
> behaviour; noted for the service owner).

Someone found it, understood it, wrote it down, and moved on. That is the most reliable place
to find real defects in a healthy codebase — not in the code nobody has read, but in the
paragraph that says "we know, but not now."

So after `git log`, read the family's trace doc and go straight to **Unverified / Unchanged /
Known differences**.

## 1.5 Scope to one shippable increment

Profile's prompt described phone verification, Memory/PKM, marketplace consent, a 150-case
semantic eval, photo continuations, sign-out, reset and deletion. Shipping all of that in one
PR means shipping none of it today.

**Take the slice that makes the prompt's own "first review milestone" true, plus every
still-true observation that is a bounded engineering fix.** Everything else becomes a ranked,
traced deferral list naming the exact files it would touch — so the next session starts from a
map, not from the prompt again.

Increment 1 was six observations. Increment 2 was the one the prompt called a *required safety
policy*. Both shipped the day they were started.

---

# PART TWO — How to stay on one thing

## 2.1 One question per command

Each bash call answers exactly one question:

```bash
grep -rn "share_kind" db/migrations/*.sql          # does this column exist?
grep -n "def requires_card_confirmation" -A12 ...  # what decides confirmation?
grep -n "HARD_CARD_CONFIRMATION_ACTION_IDS" -A6    # what is in the allowlist?
```

Not "dump the file and skim". A question you can answer in one line keeps the next decision
small. When this slipped — grepping a CI log without stripping ANSI escapes — the output was
unreadable and the command had to be redone twice.

## 2.2 Parallel for reads, serial for decisions

Three `Explore` agents ran simultaneously over the Location subsystem because they read
*different* things and none of their answers changed what the others should look for.

No two *edits* ever ran at once. Every change was: read the exact code → verify the assumption
→ make the smallest change → run the focused test → look at the result.

The test: **would knowing A's answer change how I do B?** If yes, serial. If no, parallel.

## 2.3 Background the slow, foreground the deciding

- `npm run typecheck` (minutes) → `run_in_background`, keep working
- CI checks (20+ minutes) → `Monitor` with an until-loop, keep working
- "what should this return when the response is lost" → foreground, alone, now

Never background a decision. Never foreground a wait.

*(A plain Bash `for … sleep` polling loop is refused by the auto-mode classifier as a CI bypass
even though it is read-only. `Monitor` is the supported way to wait.)*

## 2.4 Write findings outside your own context

Long sessions get summarized. A fact verified 200 messages ago is worthless if it cannot be
cited. So verified findings go into files as they are found:

- `scratchpad/<task>-grounding.md` — raw verified facts with file:line
- the plan file — the triage table and the sequenced increments
- `memory/` — only what will still be true next month

This is also what makes the final report accurate instead of reconstructed.

---

# PART THREE — Verification discipline

**Never believe a document, a test name, or your own earlier conclusion.**

1. **The doc.** The trace doc said the revoke lane was broken. True — but confirmed
   independently (`grep share_kind db/migrations/*.sql` → only in `metadata`, via migration 186)
   before any code changed.

2. **The test name.** An existing test named `test_revoke_..._names_the_sms_lane` was *passing*.
   It used `inspect.getsource()` and asserted the string `"SMS location sharing stopped"` was
   **present** in the function. It never asserted the branch was **taken**. A test that reads
   source is not a test of behaviour. Three behavioural tests made two fail immediately with
   the exact wrong values — which is what proves a bug is real and reachable, not theoretical.

3. **Your own conclusion.** After finding `confirmation.mode: "none"` on 17 authored
   `confirm_required` actions, the obvious read was "the compiler drops confirmation — live
   bug". One more grep found `action_tools.py:14-15`: *"the capability runtime, not legacy
   generated `confirm_required` metadata, decides…"*. It was deliberate. The finding stayed real
   (`HARD_CARD_CONFIRMATION_ACTION_IDS` contains exactly one action, and it is not a Location
   one) but the *characterisation* changed completely. Reporting the first version would have
   been wrong and alarming.

**A finding is not finished until you have tried to disprove it once.**

---

# PART FOUR — Implement

## 4.1 The loop

Per still-true observation: **failing test → smallest fix → green.** The failing test comes
first because it is the only proof the defect is reachable.

## 4.2 Use the repo's patterns — do not invent

| Need | Pattern | Where |
|---|---|---|
| Consequential voice action | `ToolSpec(policy=confirm_tap, firebase_plane=True, prepare=…, summarize=…, device_step=True)`; handler returns `needs="client_step"`; relay `_settle_<kind>_step` calls a **read verifier tool** and resolves the card a second time | `one_voice/tools/sos.py`, `account_lifecycle.py`, `session.py` |
| Verifier | reads the **server** (a fresh stamp, a tombstone, stored envelopes); the device's report only chooses between honest "not changed" wordings | `report_save_my_soul_delivery`, `report_account_lifecycle` |
| A 5,000-line page component | extract decisions into a pure `lib/` module with unit tests; add a **source-scan contract test** proving the page consumes it and no bare `void` / `"started"` / `"succeeded"` remains | `lib/profile/profile-action-outcomes.ts` + `__tests__/app/profile/*.contract.test.ts` |
| A result that must reach the model from any screen | always-mounted bridge next to `GlobalVoiceActionHandlers` (needs auth) or `GlobalConsentActionHandlers` (needs vault) + `useVoiceToolEffects` + `VoiceRefreshDeduper` | `profile-identity-voice-refresh.tsx`, `account-lifecycle-step-bridge.tsx` |
| Relay-level proof | the real `VoiceSession` with `FakeTransport` / `FakeLive` / `MemoryPendingStore`; inject `actor_proof` into `ToolExecutor` for firebase-plane taps | `tests/one_voice/test_relay_*_lifecycle.py` |

## 4.3 Honest status vocabulary *is* the product

Most of the work in these three features was not adding capability. It was making the system
stop claiming things it had not verified:

| Claim | What it had to become |
|---|---|
| `"started"` after `void handleDeleteAccount()` | await the typed outcome; `"started"` deleted |
| `"Sent that to support."` after an early `return` | `too_short` / `offline` / `rejected` / `failed`, each naming why |
| `"Account reset"` from a resolved promise | `success && account_reset` from the server, else `unknown` |
| cancel and plugin-failure both `null` | `cancelled` vs `failed(reason)`, cause named only where the platform names it |
| device says "deleted" | server tombstone says deleted, or it is `not_changed` |

Three distinctions to internalise:

- **`unknown` ≠ `failed`.** A lost response after a possible commit is not a failure. "That
  didn't work" invites a retry of something that may already have happened.
- **An interim status is not a success.** `*_step_issued` must be in *both*
  `protocol.NOT_OK_STATUSES` and `session._AWAITING_DEVICE`, or the turn reads "complete"
  before anything is verified.
- **A device's report is a hint, never the outcome.** The server re-reads its own state.

## 4.4 Adding a Live tool — all five, or CI refuses

1. `gateway_action_id` must exist — author it in the surface's `*.voice-action-contract.json`
   (`voice_tool` path) if it does not. `registry.validate_gateway_binding()` must return `[]`.
2. Regenerate in **DAG order**: registry → gateway → route index → projection → graph → card
   catalog → route index → surface map → topology. Then run all seven `--check`s. Never re-run
   an upstream generator after a downstream one.
3. Add the new mutation tool to `forbidden_tools` for every no-mutation-family case in
   `tests/one_voice/fixtures/{circle,connections,sos}_tool_selection.v1.json` — each eval names
   its own families (`clarify` / `unknown_recipient` / `follow_up`).
4. Add the new test files to `consent-protocol/scripts/test-ci.manifest.txt`, or the protocol
   lane silently skips them.
5. A new route action can push the page's published control labels out of the 10-slot
   `available_actions`; published actions come first in `screen-context-builder.ts`.

## 4.5 Before pushing

The family's `tests/one_voice/`, the touched service suites, the frontend voice + feature
suites, `npm run typecheck`, eslint on touched files, `ruff format` + `ruff check` on touched
files, every generator `--check`, and `bash scripts/ci/repo-governance-check.sh`.

---

# PART FIVE — Ship

```bash
git fetch --prune origin && git rebase origin/main        # Base Freshness Gate hard-fails if behind
git push -u origin <branch> && gh pr create --base main ...
# watch CI on the EXACT head via Monitor
gh pr merge <N> --admin --merge --match-head-commit <FULL_40_SHA>   # silence is not success
gh pr view <N> --json state,mergeCommit                            # must print MERGED <sha>
# wait for Main Post-Merge Smoke Gate on the MERGE sha, then:
gh workflow run deploy-uat.yml --ref main -f scope=auto -f sha=<MERGE_SHA>
```

**Deploy preflight** — print it before dispatching: `main_tip_sha`, its smoke gate,
`uat_actual_sha` per service (the serving revision's `deploy-sha` label), active deploy-uat
runs. Never deploy "latest main".

**Watch your run's *Resolve deployment scope* step** and confirm `--target-sha` is yours and
`deploy_backend` / `deploy_frontend` are what you expect. On 2026-09-18 a teammate's dispatch
two seconds later cancelled mine via the concurrency group, went green for an older SHA, and
the fix was not on UAT. The URL `gh workflow run` prints *is* your run.

**Post-deploy proof** (not HTTP 200):

```bash
gcloud run services describe <svc> --project hushh-pda-uat --region us-central1 --format=json
#   serving revision (percent == 100) == latestReadyRevisionName
gcloud run revisions describe <rev> --format='value(metadata.labels.deploy-sha)'
#   == the merge SHA
```

gcloud here is the non-expiring operator SA; if it says "Reauthentication failed", run
`~/bin/hushh-gcp-operator-setup`, never `gcloud auth login`.

---

# PART SIX — Mistakes made, and the rule each produced

| Mistake | Cost | Rule now |
|---|---|---|
| Ran `git stash` for a baseline, despite memory forbidding it | none (`stash@{0}` survived) — luck, not process | baseline with `git worktree add --detach /tmp/wt-base origin/main` |
| Dispatched UAT, watched a run, reported success | the fix was **not on UAT** — a teammate's dispatch 2s later cancelled mine and went green for an older SHA | read the *Resolve deployment scope* step; confirm `--target-sha` and the scope flags |
| Wrote the memory note as "don't trust the dispatch URL" | would have misled the next session | the URL *is* correct; the trap is the concurrency cancel — memory corrected |
| Re-ran the route-index generator after the topology index | Governance failed → Preflight failed → **all expensive lanes skipped**; one full CI cycle | the generators are a DAG; restart from the graph and re-run all seven `--check`s |
| `git push 2>&1 \| grep -E "->\|…"` | the push silently never happened; caught only by checking the PR head | never pipe a mutation through a filter that can eat it; verify state, never infer from silence |

The common thread in the expensive two: **inferring success from the absence of an error.** A
green workflow, a printed URL, a silent command — none are evidence. Check the thing itself.

---

# PART SEVEN — What "done" means, and how to report it

Not merged. Not green. Not deployed. Done is: the serving revision's `deploy-sha` label equals
the merge SHA, on every service the scope step said would deploy.

Report as a table — PR, merge SHA, CI, deploy run + resolved scope, serving revisions with
their `deploy-sha`, health — then **what changed for the user** in plain words, the numbers
(tests, zero manual), and what was deferred and why, ranked. Name anything that could not be
verified. Never write "should work".

---

## Environment traps

- `git stash` is forbidden in this checkout (`stash@{0}` is a safety snapshot); use a detached
  worktree and symlink `node_modules` for vitest only — never for a CI lane, whose `npm ci`
  will empty the main checkout's install.
- `~/bin` is not on PATH; the classifier refuses `chmod +x` into it — write the file, ask.
- Pre-existing red on `main` (`route-playbook-contract`, ruff formatting drift): prove it on a
  clean worktree, name it in the PR, leave it. Do not widen scope.
- The `.skill` files under `skillsagentic/` are zips; `unzip -d` them to read.

Related: `hushh-research-ship`, `gcp-access`, `safe-changes`, `location-header-system`.
