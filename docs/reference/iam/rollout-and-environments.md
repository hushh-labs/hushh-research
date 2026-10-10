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
