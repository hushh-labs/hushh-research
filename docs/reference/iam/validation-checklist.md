# Validation Checklist


## Visual Context

Canonical visual owner: [IAM Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose

Provide the canonical verification gate for Investor + RIA IAM changes.

## Pre-Check

1. Confirm target environment (local, UAT, or production).
2. Confirm correct secrets/config profile for that environment.
3. Confirm route and API contracts are updated.

## Functional Checks

1. Persona switch restores `last_active_persona`.
2. Investor and RIA route trees enforce actor gates.
3. Marketplace tabs render expected public-card data.
4. Consent request/approve/deny/revoke flows complete end-to-end.
5. Schema-missing compatibility:
   `GET /api/iam/persona` returns investor-safe `200`,
   `/api/ria/*` and `/api/marketplace/*` return `503 IAM_SCHEMA_NOT_READY`.

## Policy Checks

1. Unverified RIA cannot request investor private scopes.
2. Duration cap enforcement blocks values above `365d`.
3. Scope validator blocks out-of-family scope requests.
4. Revoked/expired relationships lose data access immediately.

## Security and Privacy Checks

1. No private data leakage in public surfaces.
2. Audit records include actor/scope/duration metadata.
3. Telemetry remains metadata-only.
4. No raw secrets or sensitive payloads in logs.
5. Trusted-device authorization is UAT-flagged and allowlisted.
6. Device codes and challenges are short-lived, single-use, and replay-safe.
7. Device owner capabilities require Firebase identity plus a fresh P-256 signature.
8. Device revocation rejects challenges and subsequent owner-capability issuance.
9. Developer tokens cannot mint `VAULT_OWNER`, unwrap the vault, or write PKM.
10. Connected Systems never unlinks on timeout, authorization failure, MCP
    error, or malformed response; owner-confirmed recovery disconnects only the
    server-resolved active binding and preserves workflow/audit history.
11. Nearby presence defaults to absent, requires fresh owner confirmation and
    phone verification, and is visible only to another explicitly active
    check-in whose independently confirmed point is inside the fixed exact
    radius.
12. Nearby roster and Connect responses expose rotating aliases and safe display
    labels only—never peer coordinates, distance, selected place, email, phone,
    or stable user ids.
13. Check out synchronously clears encrypted anchor/candidate material. Expiry
    synchronously blocks roster and alias resolution; the next feature
    operation or the required hosted hourly retention job scrubs due material
    and leaves only bounded metadata for account deletion and the 12-hour
    Location retention purge.
14. Candidate tokens are short-epoch, server-keyed, and broad-phase only.
    Exact point-to-point distance is rechecked after decryption; Connect binds that result to
    both presence versions and atomically rechecks eligibility on insert.
15. GPS-only nearby simulation is unavailable in production even when its
    mode is misconfigured; Check out remains available while discovery is
    disabled.

## Ecosystem Checks

1. Agents and Operons respect consent scope boundaries.
2. MCP access remains token-scoped.
3. A2A delegation does not escalate scopes.
4. TrustLinks verify signature, expiry, scope, and session binding where the caller has a server-derived session id.
5. ADK/A2A compliance checks pass.

## Exit Criteria

1. All checklist sections pass.
2. No open P0/P1 IAM defects.
3. Rollback steps are documented.
