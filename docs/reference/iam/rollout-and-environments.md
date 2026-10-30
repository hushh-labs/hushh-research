# Rollout and Environments


## Visual Context

Canonical visual owner: [IAM Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose

Define environment policy for IAM changes without risking production behavior.

## Environment Matrix

| Environment | Purpose | IAM Change Policy |
| --- | --- | --- |
| local | Developer iteration and contract validation | Local-only tests; no production resources |
| dev | Admin-authorized shared Dev rehearsals | CI-green scoped deployment; no live payments or production identity changes |
| uat | Integration validation for actor flows and verification gates | Auto-deploy from the latest green `main` SHA |
| production | Live user traffic | No IAM contract change without explicit promotion gate |

## UAT managed text processing policy

`private_drive_text_uat` in `consent-protocol/config/managed-ai-runtime.json`
owns the versioned administrator policy for `one_text_chat_and_drive_requests`.
All existing and new UAT accounts use the candidate-verified provider for managed
One text chat and semantic Drive document-request planning and relevance assessment.
Release admission requires the provider named by `managed_provider_selection.uat`
(Azure today) to pass; a passing alternate cannot replace it, so its failure blocks
release. The API and both worker revisions share that binding. Historical
personal pilot receipts and model preferences do not select that processor.
Their original acceptance/revocation timestamps remain unchanged; no receipt is
created or marked accepted by this rollout. The separate `managed_runtime_uat`
administrator policy extends selected-UAT processing to text/media, Search, exact
public-source retrieval, Location transcription/semantics, narration, Live Voice
and compatible embeddings. It grants no owner-information or action authority.
Every declared capability must have an Azure replacement before this release
can proceed; candidate admission accepts either complete provider bundle.
Production and BYOK retain their existing processor contracts.

`runtime_providers/managed_text.py` owns policy resolution, central Azure binding,
per-call fallback and safe provider telemetry. It reuses the existing UAT PWM
Azure endpoint/deployment and workload identity. Each model call tries the selected
provider first; one alternate call is allowed only for an unobserved timeout, connection
failure, quota response or transient 500/502/503/504. Configuration, authentication,
permission/consent errors, schema failure and cancellation do not allow fallback.
Any emitted model frame prevents replay. No Runner, tool, payment or grant is
retried by provider failover. Chat never calls an alternate provider: Azure chat allows 10s before
first output (30s after an actual Search declaration or tool response) and native Vertex chat 60s,
within its existing event budget; an observed stream has a bounded 60s completion window and remains
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

## Temporary Dev Reviewer Phone Transport

The existing authenticated `/api/account/phone/uat-test/start` and `/confirm`
endpoints admit a dedicated recorded transport on shared Dev only. Its separate
`HUSHH_DEV_REVIEWER_PHONE_TEST_CONFIG_JSON` Secret Manager binding is optional
and default-off. The strict configuration contains an enable boolean, designated
primary UID, exact US E.164 phone, six-digit code, independent challenge secret,
approved Sandbox account and a Unix expiry no more than 24 hours ahead.

Runtime and deploy lane must both be `dev`, deployment source must be
`deploy-dev`, review mode must be enabled, and the frontend origin must be
`https://dev.one.hushh.ai`. A production runtime profile always rejects this
transport. The account is pinned to the approved test Sandbox and the primary
must match the first owner in the independently validated commerce Sandbox
policy. The unrelated global reviewer fixture is never reassigned.

Challenges bind authenticated owner, exact phone, configuration revision, nonce
and a ten-minute expiry. Confirmation rechecks all admission and proof fields
before the existing canonical phone-claim authority persists the
`dev_reviewer_test_phone_claim` source. No Firebase project-wide test-number
registration or production/UAT secret fallback is introduced. Expired or missing
configuration closes admission; cleanup removes this dedicated secret binding
after the synthetic rehearsal and retains existing identity/audit history.

## Firebase authority containment

The backend Firebase Admin app validates the configured credential project against
the initialized app, including reused apps and ADC initialization. Production
(`ENVIRONMENT=production` or `APP_RUNTIME_PROFILE=prod`) remains pinned to
`hushh-pda`; this change does not recreate accounts or change UIDs, providers,
vault records or encryption keys.

While legacy UAT clients still authenticate against that shared production
authority, non-production backends retain token verification for compatibility.
Account deletion, disable/revoke, and enterprise SSO identity, claim and token
mutations now refuse shared-PROD writes. Refused cleanup remains pending
for retry instead of disabling a production identity. Web Admin initialization
also requires an explicit client project and matching credentials.

These guards do not complete the Auth migration. Existing native clients retain
embedded backend/Auth settings, and client SDK identity changes still reach the
shared realm. Before changing UAT authority, inventory customer-bearing legacy
builds and data, prove cross-realm token rejection, and reconcile recovery paths.
Inventory the remaining profile, account-claim and email-auth callers before
declaring the shared directory fully isolated; these guards cover the named
lifecycle/SSO paths, not every identity operation.
Legacy account-cleanup intents contain only a UID: park or resolve them under
their original authority before switching credentials, so a reused UID cannot
target a different registry.

Public iOS submission requires the production backend target. Production iOS
Firebase and native plist inputs come from production Secret Manager rather than
UAT; Apple signing custody remains unchanged. The UAT-only Android workflow
rejects live production-track uploads. Native config sync validates project and
sender against the same platform environment overlay used by Capacitor; distinct
web/native app IDs remain valid. None of these checks redirects installed apps.

Environment-separated metrics require verified registry membership as well as
backend and stream provenance. Moving UAT does not classify historical shared
accounts or exclude staff testing production. The dashboard companion change
withholds ambiguous account totals until each registry is independently verified.
