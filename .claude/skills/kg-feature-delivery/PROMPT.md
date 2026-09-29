# The One Voice domain prompt

Paste everything below the line into a fresh chat, attach the domain's knowledge-graph
`.html`, and replace `<DOMAIN>`. That is the whole input. It has produced Circle, Connect,
Save My Soul, and Profile (identity + account lifecycle) on this repo.

---

# Implement the One Voice agent for `<DOMAIN>`

Repository: `hushh-labs/hushh-research`
Attached: the `<DOMAIN>` knowledge graph (`.html`). Read its narrative, its numbered
observations, its source index, and its embedded `script#graph-data` JSON.

Build the voice agent for `<DOMAIN>` the same way Circle, Connect, Save My Soul and Profile
were built: a family of typed Live tools whose tier matches the consequence, whose success
words come only from server evidence, wired into the existing relay, proved by automated
tests, merged, and deployed to UAT by exact SHA. Take it end to end. Do not stop at a plan, a
tool description, or a screen that opens.

**No manual testing. Automated tests only. One sitting. Time is precious.**

---

## 1. Before you write anything: measure the checkout

The graph traces a commit that is not HEAD. Part of what it describes is usually already
merged, part is still true, and part was only ever documented. You cannot tell which by
reading it — only the repository can tell you.

```bash
git checkout main && git fetch --prune origin && git pull --ff-only origin main
git log --oneline -40 | grep -iE "<domain words>|voice|one_voice"   # was this already shipped?
gh pr list --state open --base main                                  # who else is in these files?
ls consent-protocol/hushh_mcp/one_voice/tools/                       # does a family module exist?
grep -n 'name="' consent-protocol/hushh_mcp/one_voice/tools/<domain>.py 2>/dev/null
python3 -c "import json;print([t['name'] for t in json.load(open('contracts/kai/one-voice-live-tools.v1.json'))['tools']])"
```

Then run the domain's existing suites to get a **baseline** — you will need it later to prove
any failure is pre-existing rather than yours.

Now triage **every numbered observation in the graph** by opening the exact file it names:

| Verdict | Meaning | Action |
|---|---|---|
| still true | the defect is in the checkout right now | this is the work |
| already fixed | someone shipped it since the graph | skip, say so |
| documented-only | described, never implemented | this is also work, but different |

Write that table down before any code, with the `file:line` that proves each row. It becomes
your scope, your PR body, and your report.

**Also read `docs/reference/one/<domain>-voice-trace.md` if it exists, and go straight to its
"Unverified" / "Unchanged" / "Known differences" section.** That paragraph — the one a previous
engineer wrote as "we know, but not now" — is the most reliable source of real defects in this
codebase. The Save My Soul bug was sitting there, documented and unfixed.

---

## 2. What a One Voice domain agent actually is

A family module `consent-protocol/hushh_mcp/one_voice/tools/<domain>.py` exporting
`TOOLS: tuple[ToolSpec, ...]`, added to `_family_tools()` in `tools/registry.py`.
Existing families: `session`, `people`, `location_state`, `sharing`, `circles`, `sos`,
`profile`, `account_lifecycle`, `onboarding`. 66 tools today.

### 2.1 Every tool is a `ToolSpec`

```python
ToolSpec(
    name="...",                      # the Gemini function name
    gateway_action_id="...",         # MUST exist in the Kai action gateway
    policy=ToolPolicy...,            # read | direct | confirm_voice | confirm_tap
    input_model=...,                 # pydantic ToolInput
    output_model=...,                # pydantic ToolResult with a Literal status
    description="...",               # the model's only instruction for this tool
    handler=...,
    person_args=("person",),         # args that must name a CONFIRMED person
    circle_args=("circle",),         # args that must name a CONFIRMED circle
    ui_refresh=("...",),             # surfaces to refetch after a real change
    firebase_plane=False,            # tap needs a fresh verified Firebase proof
    summarize=...,                   # confirm_*: the card sentence
    prepare=...,                     # confirm_*: compute the exact effect before the card
    device_step=False,               # the result hands the client a step to run
)
```

### 2.2 Choose the tier by consequence, never by convenience

| Tier | Use for | Examples |
|---|---|---|
| `read` | anything that changes nothing | `get_profile`, `list_circles`, `get_save_my_soul_status`, and **every verifier** |
| `direct` | trivially reversible, no confirmation | navigation-ish helpers |
| `confirm_voice` | a reversible mutation; a spoken yes is enough | `create_circle`, `rename_circle`, `invite_person`, `add_emergency_contact` |
| `confirm_tap` | consequential, destructive, or irreversible; **only a physical tap arms it** | `trigger_save_my_soul`, `stop_save_my_soul`, `delete_circle`, `remove_connection`, `remove_emergency_contact`, `update_display_name`, `set_contact_discoverable`, `reset_account`, `delete_account` |

`firebase_plane=True` on identity/privacy/lifecycle taps: the confirm frame must carry a fresh
Firebase proof that is *verified* (signature, expiry, revocation, and that it names this
session's user), not merely present. A refused proof leaves the card pending so the person can
tap again.

The gateway is the ceiling: a gateway action marked `confirm_required` can never be weakened
to a lower tool tier. `registry.validate_gateway_binding()` enforces this and must return `[]`.

### 2.3 `prepare` and `summarize` — the card must name the real effect

`prepare(ctx, args) -> Prepared | ToolResult` runs **before the card is shown**, reads live
authorized state, and returns:

- `Prepared(summary=..., snapshot={...})` — `summary` is the card sentence naming exactly who
  and what; `snapshot` is stored with the pending row and handed back as `ctx.prepared` so
  execution can detect drift instead of silently doing something else.
- a `ToolResult` instead — answers without a card when there is nothing to do, the state is
  unreadable, or the effect is already active.

On execution, compare `ctx.prepared` against live state and **refuse on drift**. A card that
said "Ayesha and Ravi" must never send to a roster that changed underneath it.

### 2.4 Entity resolution — a spoken name is never an id

Never accept a name as a target. `person_args` / `circle_args` make the executor refuse a call
whose argument is not a **confirmed** entity, returning `needs="disambiguation"`. The flow is
`list_*` or `resolve_person` → `confirm_person` → the mutation. Never skip `confirm_person`.

### 2.5 Device steps — when the server cannot be the one that acts

If the effect needs the device (a captured position, a vault-owner authority resolved on the
client, an OS picker, local cleanup, sign-out), the tool does **not** execute. It returns:

```python
return SomeResult(
    status="<x>_step_issued",         # an INTERIM status, never success
    needs="client_step",
    spoken_facts=["Doing that now."], # never a success word
    client_step={"kind": "<domain>_<verb>", "operation": ..., "user_id": ctx.user_id,
                 "issued_at_ms": ..., "timeout_s": ...},
)
```

Set `device_step=True` on the spec (plain HTTP confirmation is then refused, because there
would be no publisher). Bind the step to the owner and the operation so a report cannot be
redirected or narrowed.

Then, in `one_voice/session.py::_client_step_result`, add a branch to a
`_settle_<domain>_step` that:

1. reads the **server**, via a `read`-tier verifier tool, using the *step record's* values —
   never the client's payload;
2. attaches `device_step={"status": frame.status, "late": ...}`;
3. resolves the pending card a **second time** with the verified outcome;
4. sets `ok` only for genuinely successful statuses.

The device's report is a **hint**, used only to choose between honest wordings of "not
changed". It can never produce a success. Examples: a device claiming `deleted` with no
tombstone is `not_changed`; a tombstone with a lost device reply is still `account_deleted`.

### 2.6 Status vocabulary is the product

This is where most of the real work is. Rules:

- **`unknown` ≠ `failed`.** A lost response after a possible commit is not a failure — saying
  "that didn't work" invites a retry of something that may already have happened.
- **An interim status is not a success.** Add every `*_step_issued` / `*_pending` status to
  **both** `protocol.NOT_OK_STATUSES` **and** `session._AWAITING_DEVICE`, or the turn reads
  "complete" before anything is verified.
- **Success comes from server evidence only** — a stored envelope, a fresh DB stamp, a
  tombstone, a re-read row. Never from a resolved promise, an HTTP 200, or a client boolean.
- Distinguish `needs_unlock`, `blocked_external`, `not_changed`, `unverified` from each other
  and say what is true of each.
- A model-supplied `confirmed: true` is never authorization. Strip it.

### 2.7 The instruction

Add one numbered rule to `one_voice/instruction.py` for the domain: what the words mean, which
tool each intent maps to, what is *not* a request (questions, quotes, hypotheticals,
negations), which statuses are not success, and what to say for each verified outcome.
**Append it as the last numbered rule** — `tests/one_voice/test_instruction.py` indexes rules
by number, so inserting in the middle breaks unrelated tests.

---

## 3. Wiring a new tool through the system — all six, or CI refuses

1. **Gateway action.** `gateway_action_id` must already exist. If not, author it in the
   surface's `hushh-webapp/app/**/page.voice-action-contract.json` with
   `execution_target.path: "voice_tool"`, a truthful `risk_level`, and
   `execution_policy: "confirm_required"` for anything confirmed.
2. **Regenerate in DAG order** — these digest each other; never re-run an upstream generator
   after a downstream one:
   `gateway → route-orchestration-index → one_voice tool projection → capability graph →
   location card catalog → route-orchestration-index → surface map → runtime topology index`
   Then run **all seven `--check`s** plus `bash scripts/ci/repo-governance-check.sh`.
   *(Getting this order wrong fails `Governance` → fails `Preflight` → skips every expensive
   lane, and costs a full CI cycle.)*
3. **Eval fixtures.** Add each new *mutation* tool to `forbidden_tools` for every
   no-mutation-family case in
   `consent-protocol/tests/one_voice/fixtures/{circle,connections,sos}_tool_selection.v1.json`.
   Each eval names its own families (`clarify` / `unknown_recipient` / `follow_up`) and its
   well-formedness test requires every mutation tool to be listed.
4. **CI manifest.** Add new backend test files to
   `consent-protocol/scripts/test-ci.manifest.txt`, or the protocol lane silently skips them.
5. **Frontend protocol.** Mirror new interim statuses into
   `hushh-webapp/lib/one-voice/protocol.ts` (`NOT_SUCCESS_STATUSES`) and export the step kind.
6. **Client bridge**, if there is a device step: an always-mounted component next to
   `GlobalVoiceActionHandlers` (needs auth) or `GlobalConsentActionHandlers` (needs the vault),
   using `useVoiceToolEffects({ onClientStep })`. Put the **decisions in a pure `lib/` module**
   and unit-test them; the bridge only binds the real flows. Never let a route-scoped handler
   own a capability the person can invoke from Home.

---

## 4. Tests — this is the proof, and the only testing you do

**Per still-true observation: failing test → smallest fix → green.** The failing test comes
first; it is the only proof the defect is reachable.

1. **Tool tests** — `consent-protocol/tests/one_voice/test_tools_<domain>.py`. Doubles for the
   services. Cover: tier/`firebase_plane`/`device_step` on every spec; the description forbids
   success words; `prepare` names the exact effect and snapshots the owner; `prepare` answers
   without a card in the no-op / unreadable / already-active cases; the handler refuses on
   owner change or drift; the verifier's full outcome matrix including every "device says X
   but the server says Y" pair.

2. **Relay tests** — `consent-protocol/tests/one_voice/test_relay_<domain>_lifecycle.py`, using
   the **real `VoiceSession`** with `FakeTransport` / `FakeLive` / `MemoryPendingStore` (copy
   `test_relay_sos_lifecycle.py`). Prove: the card is tap tier and names the effect; a spoken
   yes and a forged receipt arm nothing; a tap without fresh proof is refused and the row stays
   pending; the issued status is `ok: false` and the turn is not "complete"; the device report
   settles through the server verifier; **the raw client payload never reaches the model**
   (assert a sentinel string from the payload is absent from `fake.events_sent`).

3. **Frontend** — unit tests for the pure module; a **source-scan contract test** for any
   huge page component, proving it consumes the typed outcome and that no bare `void` +
   `"started"` / `"succeeded"` remains.

4. Run before pushing: the domain's `tests/one_voice/`, touched service suites, the frontend
   voice + domain suites, `npm run typecheck`, `npx eslint <touched>`, `ruff format` +
   `ruff check <touched>`, every generator `--check`, and the governance check.

**Baselines:** some tests are red on clean `origin/main` (e.g.
`__tests__/voice/route-playbook-contract.test.ts`, ruff formatting drift). Prove it on a
detached worktree off `origin/main`, name it in the PR, and leave it. Never widen scope to
"fix" unrelated red. Never run `git stash` in this checkout — `stash@{0}` is a safety snapshot.

---

## 5. Ship it

```bash
git fetch --prune origin && git rebase origin/main     # Base Freshness Gate hard-fails if behind
git push -u origin <branch> && gh pr create --base main ...
# watch CI on the EXACT head SHA (use the Monitor tool; a bash sleep-loop gets blocked)
gh pr merge <N> --repo hushh-labs/hushh-research --admin --merge --match-head-commit <FULL_40_SHA>
gh pr view <N> --json state,mergeCommit    # silence is not success: must print MERGED <sha>
# wait for "Main Post-Merge Smoke Gate" on the MERGE sha, then:
gh workflow run deploy-uat.yml --ref main -f scope=auto -f sha=<MERGE_SHA>
```

**Preflight before dispatching** — print `main_tip_sha`, its smoke-gate conclusion,
`uat_actual_sha` per service (the serving revision's `deploy-sha` label), and any active
deploy-uat run. Never deploy "latest main"; always an exact SHA.

**Watch your run's *Resolve deployment scope* step** and confirm `--target-sha` is yours and
`deploy_backend` / `deploy_frontend` are what you expect. A teammate dispatching seconds later
can cancel your run via the concurrency group; theirs goes green for an older SHA and your fix
is not on UAT.

**Done is not merged, green, or deployed:**

```bash
gcloud run services describe <svc> --project hushh-pda-uat --region us-central1 --format=json
#   serving revision (percent == 100) == latestReadyRevisionName
gcloud run revisions describe <rev> --format='value(metadata.labels.deploy-sha)'
#   == the merge SHA, on every service the scope step said would deploy
```

---

## 6. Report

A table: PR → merge SHA → CI → deploy run + resolved scope → serving revisions with their
`deploy-sha` → health. Then **what changed for the user** in plain words, the numbers (tests
run, zero manual), and **what you deferred**, ranked, with the exact files each would touch.
Name anything you could not verify. Never write "should work".

---

## Standing rules

- Own the outcome, not the code change. Inspect before asking.
- Reuse the existing service, route, flow and confirmation ceremony. Do not rebuild a subsystem
  under this domain, and do not invent a second executor, ledger or session store.
- Never fabricate an effect, weaken a confirmation tier, downgrade a failure into a success
  boolean, or put coordinates, tokens, OTPs, raw contact details or decrypted payloads into
  model context, telemetry or logs.
- A finding is not finished until you have tried to disprove it once. Do not trust a document,
  a passing test's name, or your own first conclusion — a source-scanning test that asserts a
  string is *present* has never proved the branch is *taken*.
- If part of the scope is genuinely blocked, finish everything else and say exactly what you
  left and why.
