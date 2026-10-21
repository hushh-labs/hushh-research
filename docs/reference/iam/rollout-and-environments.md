# Rollout and Environments


## Visual Context

Canonical visual owner: [IAM Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose

Define environment policy for IAM changes without risking production behavior.

## Environment Matrix

| Environment | Purpose | IAM Change Policy |
| --- | --- | --- |
| local | Developer iteration and contract validation | Local-only tests; no production resources |
| uat | Integration validation for actor flows and verification gates | Auto-deploy from the latest green `main` SHA |
| production | Live user traffic | No IAM contract change without explicit promotion gate |

## UAT managed text processing policy

`private_drive_text_uat` in `consent-protocol/config/managed-ai-runtime.json`
owns the versioned administrator policy for `one_text_chat_and_drive_requests`.
All existing and new UAT accounts use the candidate-verified provider for managed
One text chat and semantic Drive document-request planning and relevance assessment.
Azure is preferred when both providers pass; Vertex is selected when only it passes.
Neither passing blocks release. The API and both worker revisions share that binding. Historical
personal pilot receipts and model preferences do not select that processor.
Their original acceptance/revocation timestamps remain unchanged; no receipt is
created or marked accepted by this rollout. Production, BYOK, voice, native
Google Search and separately opted-in public research keep their own contracts.

`runtime_providers/managed_text.py` owns policy resolution, central Azure binding,
per-call fallback and safe provider telemetry. It reuses the existing UAT PWM
Azure endpoint/deployment and workload identity. Each model call tries the selected
provider first; one alternate call is allowed only for an unobserved timeout, connection
failure, quota response or transient 500/502/503/504. Configuration, authentication,
permission/consent errors, schema failure and cancellation do not allow fallback.
Any emitted model frame prevents replay. No Runner, tool, payment or grant is
retried by provider failover. Chat allocates 10s + 8s before first output within its existing event
budget; an observed stream has a bounded 60s completion window and remains
subject to the caller deadline. Drive allocates 30s + 20s within its owning request deadlines. Existing
bounded model correction budgets still apply. Vertex selection adds a distinct policy
generation and binding fingerprint; the unchanged Azure selection preserves its
existing bindings. Policy generation and current
invocation authority are checked again immediately before Azure send, after
workload-token acquisition, and before fallback. This is processor authority,
never file/request/payment authority.

Eligible pending ordinary semantic requests may transition through
`DriveOwnerSearchStore.migrate_request_processor`. The connector-locked transaction
reseals request and job bindings together with an encrypted administrator migration
record. It preserves request revision, successful plan/digest, cursor, pending
candidates, result envelopes, original assessment provenance and effect history.
Current connector generation, Trusted/Allow or authenticated owner authority,
lease state and request expiry are revalidated. Content reads and delivery still
check source versions. An owner takeover fences the old lease before migration.
Completed requests/searches are not migrated. A failed migration never silently
selects Gemini under this UAT policy.

The UAT deployment runs `scripts/recover_uat_text_requests.py --apply --limit=20`
from an ephemeral job using the verified serving image and existing runtime
identity/configuration. After successful same-image worker attestation, it inspects at most 200 live
queued/failed or expired-lease requests and attempts at most 20 recoveries. It
records eligible processor transitions, resumes eligible current-policy failed
jobs through existing retry checks, and wakes the existing scheduler. Preserved
paused-worker maintenance skips this operation. It makes no model, payment
or permission calls itself; repeated transitions are no-ops. Preview is the script
default. Larger backlogs require an explicitly reviewed follow-up, not an unbounded
retry loop. Completed and expired history is excluded.

Updated web clients show read-only processing information and Privacy Policy 2.9.
Stale web/native clients retain old pilot wording until refreshed/rebuilt; their
legacy receipt API does not represent the effective processing policy. No native
binaries are shipped here. Disable/rollback the administrator policy only through
an operational release; do not relabel receipts or silently rewrite bindings.


## Promotion Rules

1. IAM changes start in local, then UAT.
2. UAT checklist must pass before production consideration.
3. Production promotion requires explicit approval and rollback plan.
4. Runtime behavior is environment-owned (`ENVIRONMENT` and `NEXT_PUBLIC_APP_ENV`), not RIA feature-flag-driven.
5. IAM table activation requires explicit migration gate:
   `python db/migrate.py --iam` and `python db/verify/verify_iam_schema.py`.
6. Any UAT-backed local runtime (`local`) must fail fast on IAM verification before starting the backend or full stack.

## Branch and CI Rules

1. Route/API contract checks are mandatory.
2. Docs integrity and runtime parity checks are mandatory.
3. Security/compliance checks must pass for verification and consent policy paths.

## Non-Breaking Requirements

1. Existing investor routes remain backward compatible.
2. New actor routes must be isolated and protected by auth + consent + scope policy.
3. Consent audit semantics must remain append-only and traceable.
4. If IAM schema is not ready, investor flows stay operational via compatibility mode.
