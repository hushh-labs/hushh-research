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
REVIEWER_APP_ROUTES=/agent,/one/consent \
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
