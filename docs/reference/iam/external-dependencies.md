# External Dependencies


## Visual Context

Canonical visual owner: [IAM Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose

Track upstream systems used by IAM and consent flows, with ownership and failure policy.

## Dependency Register

| Dependency | Use | Owner | Failure Mode Policy | Notes |
| --- | --- | --- | --- | --- |
| FINRA Data API | RIA verification evidence | Product + Compliance | Fail closed for RIA activation; keep status non-active | Verify plan, auth, and quota before rollout |
| Firebase Auth | User identity bootstrap | Platform | Fail closed for authenticated surfaces | Token verification is mandatory |
| Supabase Postgres / DB backend | Consent audit and relationship state | Backend | Fail closed for access grants; audit integrity first | Event-sourced consent records remain source of truth |
| GCP Cloud Run/Monitoring | Runtime, audit visibility, alerts | Platform/SRE | Degraded mode with explicit alerts; no silent bypass | Keep alert coverage for consent failures |

## Governance Rules

1. Every dependency must have an owner.
2. Every dependency must have fail-open/fail-closed policy documented.
3. Any quota, pricing, or auth scope change requires doc update in this file.
4. Changes that affect verification or consent gates require compliance review.

## Review Cadence

1. Monthly dependency health and quota review.
2. Quarterly policy review for cost, legal, and reliability impact.
