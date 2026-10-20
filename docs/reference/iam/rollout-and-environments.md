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

## UAT Drive document processor default

`private_drive_text_uat` in `consent-protocol/config/managed-ai-runtime.json`
records the administrator rollout policy, version, UUID and exact
`drive_document_requests` scope. With the UAT Azure selector enabled, new
semantic Drive requests for existing and new accounts without an owner approval
row use this default. This is processor-use authority, never file access or an
owner acceptance receipt. No `accepted_at` is synthesized and no accounts are
bulk-enrolled in the owner-approval table.

Any existing disabled, revoked, stale or invalid owner row blocks the default.
Unavailable reads fail closed. Owners can turn processing off through the
existing authenticated approval endpoint; an absent row uses a null owner CAS
generation, not the policy generation. Policy grants are separately scoped and
versioned, and every send rechecks environment, selector, policy and owner state.
Policy UUID/version changes invalidate outstanding policy grants. Previously
sealed requests retain their original provider and authority basis.

One chat, voice, BYOK, public research, production, prices and sharing consent
are outside this default. The profile control and Privacy Policy describe this
administrator default separately from optional owner approval. Disable the
checked-in policy to roll back new enrollment and stop policy-authorized sends;
do not rewrite receipts or frozen request bindings.

Updated web clients show effective policy status and its opt-out separately from
owner approval. Stale web bundles need a refresh. Older bundled native clients
keep their owner-receipt UI until rebuilt; their legacy approval response is not
an effective processor-status response. Their owner-bound opt-out API remains
valid. This UAT rollout does not claim native UI acceptance or ship native binaries.

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
