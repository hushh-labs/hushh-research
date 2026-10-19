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
