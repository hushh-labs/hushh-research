# Rollout and Environments


## Visual Context

Canonical visual owner: [IAM Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose

Define environment policy for IAM changes without risking production behavior.

## Environment Matrix

| Environment | Purpose | IAM Change Policy |
| --- | --- | --- |
| local | Developer iteration and contract validation | Local-only tests; no production resources |
| uat | Integration validation for actor flows and verification gates | Environment-owned deployment lane (`deploy_uat`) |
| production | Live user traffic | No IAM contract change without explicit promotion gate |

## Promotion Rules

1. IAM changes start in local, then UAT.
2. UAT checklist must pass before production consideration.
3. Production promotion requires explicit approval and rollback plan.
4. Runtime behavior is environment-owned (`ENVIRONMENT` and `NEXT_PUBLIC_APP_ENV`), not RIA feature-flag-driven.
5. IAM table activation requires explicit migration gate:
   `python db/migrate.py --iam` and `python scripts/verify_iam_schema.py`.
6. Any UAT-backed local runtime (`local-uatdb`) must fail fast on IAM verification before starting the backend or full stack.

## Branch and CI Rules

1. Route/API contract checks are mandatory.
2. Docs integrity and runtime parity checks are mandatory.
3. Security/compliance checks must pass for verification and consent policy paths.

## Non-Breaking Requirements

1. Existing investor routes remain backward compatible.
2. New actor routes must be isolated and protected by auth + consent + scope policy.
3. Consent audit semantics must remain append-only and traceable.
4. If IAM schema is not ready, investor flows stay operational via compatibility mode.
