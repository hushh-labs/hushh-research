# Reviewer Rehearsal Preflight

Run this gate before opening Chromium. A browser assertion is not evidence when
the local runtime cannot mint the canonical reviewer session or the application
can mutate a shared fixture while it is being observed.

## Required conditions

1. Classify the run as `read_only` or `mutation_authorized` first. Routine
   review is always read-only.
2. Resolve the canonical reviewer through `reviewer-test-identity.mjs`. For a
   local UAT-backed rehearsal, set `REVIEWER_SECRET_PROJECT=hushh-pda-uat`.
   The preflight reads the approved Secret Manager values into its process only;
   it never writes them to a profile, output, trace, or artifact.
3. For localhost, run `REVIEWER_SECRET_PROJECT=hushh-pda-uat bash
   scripts/env/reviewer_mode.sh enable`, restart the backend, and prove review
   mode is enabled. This places only the stable reviewer subject in the ignored
   backend overlay. The passphrase remains memory-only. The preflight performs
   this proof and fails with the exact missing condition.
4. In read-only mode, the browser harness blocks unapproved state-changing
   requests. A blocked request is a failure: fix the app's test posture or use
   an isolated mutation fixture with explicit authority.
5. After any local rehearsal, run `bash scripts/env/reviewer_mode.sh disable`
   and restart the backend.
6. A repeated `vault_error` is an identity/wrapper parity failure. Never work
   around it by writing the passphrase to a local env file. Use the reconciliation
   audit below; it can repoint only the canonical UID, only when the existing
   Secret Manager passphrase already authenticates the selected account wrapper.

## Commands

```bash
REVIEWER_SECRET_PROJECT=hushh-pda-uat \
REVIEWER_APP_ORIGIN=http://localhost:3000 \
node .codex/skills/reviewer-app-testing/scripts/reviewer-rehearsal-preflight.mjs

REVIEWER_SECRET_PROJECT=hushh-pda-uat \
REVIEWER_APP_ORIGIN=http://localhost:3000 \
REVIEWER_APP_ROUTES=/,/one/consent \
node .codex/skills/reviewer-app-testing/scripts/verify-reviewer-byok-navigation.mjs

consent-protocol/.venv/bin/python \
  .codex/skills/reviewer-app-testing/scripts/reconcile-reviewer-identity.py \
  --email reviewer@example.com

# Explicit operator authority is required for this recoverable Secret Manager mutation.
consent-protocol/.venv/bin/python \
  .codex/skills/reviewer-app-testing/scripts/reconcile-reviewer-identity.py \
  --email reviewer@example.com \
  --execute \
  --confirm-email reviewer@example.com
```

## Failure modes, by symptom

These have each cost hours. Match the symptom before debugging the app: in every
case below the application was fine and the harness was being driven wrong.

| Symptom | Cause | Fix |
| --- | --- | --- |
| The page sits on `Restoring reviewer session…` and never settles | `expectedUserId` was pinned to a value that disagrees with the reviewer the deployed app actually restores. The bootstrap refuses to settle rather than proceed as the wrong subject. | Let `createReviewerSessionHarness` supply the identity. Never hand-inject `expectedUserId` from a value you resolved yourself. |
| `That passphrase did not match` against a deployed environment | Reviewer wrapper drift: the Secret Manager passphrase no longer authenticates that account's wrapper. `REVIEWER_VAULT_PASSPHRASE` rotates often, so "latest" is not automatically the live one. | Run the reconciliation audit above. Do NOT write a passphrase into an env file, and do NOT re-key a shared fixture without explicit operator authority. |
| The harness never signs in, or asserts against a signed-out shell | Wrong origin variable. These scripts read `REVIEWER_APP_ORIGIN`. `HUSHH_APP_ORIGIN` belongs to the separate `hushh-webapp/scripts/testing/verify-signed-in-routes.mjs` harness. | Set `REVIEWER_APP_ORIGIN`. |
| Review mode looks enabled but the session never mints | The backend was not restarted after `reviewer_mode.sh enable`, so it is still serving the pre-toggle configuration. | Restart the backend, then re-run the preflight. |
| A selector that works locally finds nothing on a deployed origin | The rehearsal was hand-rolled with raw Playwright and coupled to one element id (for example `#unlock-passphrase`). | Use the shared harness. It owns unlock, continuity, and navigation; hand-rolled scripts silently drift from it. |

The rule underneath all of these: **do not hand-roll a reviewer Playwright
script.** Compose `createReviewerSessionHarness` from
`scripts/reviewer-session-harness.mjs`, which owns identity resolution, the
visible vault challenge, `vaultKeyHash` continuity, in-app navigation, and
owner-token reads. A bespoke script reproduces those badly and proves less.

## Evidence standard

A passing rehearsal reports canonical identity resolution, the visible
locked-vault challenge, same-session continuity, and cold-session re-unlock. A
healthy server, review-mode response, or static script check is not a browser
pass. Report the first failed boundary and mutation policy—never secrets,
tokens, plaintext information, or screenshots containing them.

## Wallet rehearsal

`verify-reviewer-wallet.mjs` requires explicit
`REVIEWER_ALLOW_SHARED_MUTATIONS=true`: it adds, reveals, and removes audit cards
on the shared reviewer fixture and deletes the conversations it creates. It
proves, in order: the visible vault challenge on cold entry to `/one/wallet`; a
`POST /api/pkm/store-domain` 200 for a valid card; client-side refusal of a
region-locked brand outside its market and of a checksum failure, each with no
network call; on-device reveal and hide; ciphertext-only owner reads of the
domain; the Agent Chat permutations (list returns last4 and never the PAN, add
through the secure widget, reveal by last4 and by nickname renders the widget
while assistant text never carries a secret, an unknown card fails closed
without a widget, a pasted PAN is blocked before any `/api/one/agent-chat`
call); no internal error text leaks; then cold-session re-unlock readback and
cleanup. Non-2xx first-party response bodies are captured in
`tmp/reviewer-wallet-report.json` (mode 0600) so a refusal names its
validator code instead of a bare status. The first run of this rehearsal
caught a real defect: manifest scope handles must be opaque `s_…` values, or
the mutation plan built from them is rejected with 422 on every first write.

### Same-session Memory proof (added 2026-09-02)

The rehearsal's Memory step proves that a domain written on `/one/wallet` is
visible on `/one/pkm` without a manual refresh, and that "Recently learned"
opens `/one/pkm/recent`. It must travel with `reviewer.navigateInApp`: a
`page.goto` is a document load, which drops the memory-only vault key (the
vault challenge renders instead of categories) and resets the in-memory PKM
invalidation epoch, so it would prove nothing about same-session freshness.
The reveal flow retries the prompt once when the model answers in words
without offering the action; a second silent turn is a real failure.

## Read-only guard exemptions

A rehearsal explicitly authorized to process source text without saving it can
pass `allowMemoryPreparation: true` to the canonical harness. This permits only
`POST /api/pkm/memory/proposals` on that harness's exact application origin.
Saving, consent mutations, and Chat-history writes remain blocked. The harness
awaits guard installation before navigation. This mode still sends submitted
text through the application's provider-processing boundary; it does not make
preparation on-device-only. Retain only counts and sanitized outcome codes.

The guard exempts `identitytoolkit.googleapis.com` and
`securetoken.googleapis.com` (the reviewer login handshake: custom-token sign-in,
account lookup, token refresh) and the Next dev `__nextjs_original-stack-frames`
endpoint. Authentication is never a fixture mutation; blocking it made every
localhost read-only rehearsal fail at the first boundary.

## Confirm-required actions in Agent Chat

One handles a `confirm_required` action in two phases: it first asks in words
("Reveal your card ending in 4444 on your screen?") and only calls
`run_app_action` after a verbal yes; the browser then stages the confirmation
card for a tap. A rehearsal that sends the request and waits for the widget
will time out. Send the request, let the assistant settle, answer "Yes" once if
no widget appeared, then confirm the staged card (`specialist-directive-confirm`)
and wait for the widget. `verify-reviewer-wallet.mjs` encodes this as
`revealFlow`. Actions that owe no confirmation (`allow_direct`) run on their
own once the parked directive reaches the browser, so `directive_clicks=0` is
the expected evidence for them.

## Consent lifecycle from chat rehearsal

`verify-reviewer-consent-chat.mjs` is a mutation-authorized discovery/send/withdrawal
rehearsal, not full approval or encrypted-readback acceptance. Supply the intended
counterpart's canonical public reference in `REVIEWER_COUNTERPART_PERSON_REF` and
an explicitly selected synthetic field in `REVIEWER_CONSENT_SCOPE_REF`, in process
memory. Never fall back to the first connection or ambiguity candidate.

The rehearsal requires the requester's existing connector configuration; it does
not create a hidden setup request. Connector reads use `REVIEWER_BACKEND_ORIGIN`
(default `http://localhost:8010`). It uses a unique run purpose, one visible
confirmation per mutation, the exact returned bundle ID, and current per-item
states. Failed status reads are failures, not evidence of cancellation. Request
drafts targeting another person or extra fields are blocked before submission.

Reports contain sanitized outcomes and source identity, never assistant excerpts,
response bodies, or decrypted values. Test requests and conversations are retained;
baseline-difference cleanup is prohibited on shared accounts. A passing run still
does not prove approval, exact encrypted readback, restored cards or cold recovery.

### Exact consent readback

For named multi-account journeys, verify that the resolved primary/counterpart
identities match the task's authorized accounts before opening Chromium. A
successful review-mode preflight proves configuration availability, not that the
default primary is the intended person. Use the existing child-process slot
overrides and `REVIEWER_AUTH_MODE=custom_token` when local email/password fixtures
belong to a different identity; never suppress the UID mismatch guard.

`verify-reviewer-consent-readback.mjs` composes the same reviewer harness. It
requires `REVIEWER_COUNTERPART_PERSON_REF`, `REVIEWER_EXPECTED_BUNDLE_ID`,
`REVIEWER_EXPECTED_REQUEST_ID`, `REVIEWER_CONSENT_SCOPE_REF`, and
`REVIEWER_EXPECTED_PAYLOAD_JSON` in process memory from the authorized synthetic
journey. Missing bindings stop before browser startup. It never picks an arbitrary
historical grant or treats substring matching as exact readback. The ordinary
JSON view is compared entirely inside the browser, then returned to formatted
view; exact object equality rejects extra siblings. The same binding is checked
after cold re-unlock. No decrypted values or unrelated grant labels are logged.
`REVIEWER_EXPECTED_PAYLOAD_JSON` must describe the rendered domain projection:
Profile unwraps the selected domain before passing it to its JSON view. Do not
include the enclosing domain key or the export envelope's dynamic timestamp in
that expectation. This check does not independently prove the entire encrypted
envelope's authority or absence of information outside the displayed projection;
those remain separate export-integrity and scope-isolation requirements.
This proves the specified retained grant, not fresh submission or Chat restoration.
