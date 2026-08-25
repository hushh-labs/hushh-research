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
5. Every `attr.source_library.*` scope is rejected at discovery, request,
   approval, token validation, export, download, refresh, and public projection.
6. One Location standing auto-approval revalidates the named contact or Circle
   relationship at grant mutation time; a stale client snapshot cannot mint a
   grant after relationship removal.
7. One Location standing auto-approval rejects pre-existing, partial-rule, and
   `until_stopped` requests; those remain pending for an explicit owner action.
8. One Location approval requires explicit `manual` or `automatic` intent;
   omitted intent and mismatched rule/duration context fail before mutation.
9. Contact sync requires current verified phones plus explicit versioned
   combined find-and-auto-connect consent. Legacy/default discoverability,
   cached clients without `contact_find_auto_connect_v1`, missing schema,
   missing enablement evidence, and version zero fail closed.
10. Every eligible non-suppressed contact match becomes connected without a
    request/accept step; a revoked pair remains suppressed until a separate,
    explicit reconnect action occurs.

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
10. Contact-sync graph mutation writes no location grant, envelope, SMS
    selection, scope proposal, PKM value, capability, or private-information
    record. Contact-only relationships cannot use standing `all_contacts`
    location auto-approval.
11. Connected Systems never unlinks on timeout, authorization failure, MCP
    error, or malformed response; owner-confirmed recovery disconnects only the
    server-resolved active binding and preserves workflow/audit history.
12. Nearby presence defaults to absent, requires fresh owner confirmation and
    phone verification, and is visible only to another explicitly active
    check-in whose independently confirmed point is inside the fixed exact
    radius.
13. Nearby roster and Connect responses expose rotating aliases and safe display
    labels only—never peer coordinates, distance, selected place, email, phone,
    or stable user ids.
14. Check out synchronously clears encrypted anchor/candidate material. Expiry
    synchronously blocks roster and alias resolution; the next feature
    operation or the required hosted hourly retention job scrubs due material
    and leaves only bounded metadata for account deletion and the 12-hour
    Location retention purge.
15. Candidate tokens are short-epoch, server-keyed, and broad-phase only.
    Exact point-to-point distance is rechecked after decryption; Connect binds that result to
    both presence versions and atomically rechecks eligibility on insert.
16. GPS-only nearby simulation is unavailable in production even when its
    mode is misconfigured; Check out remains available while discovery is
    disabled.
17. Forged or stale Source Library manifests, paths, scope-registry rows, grants,
    and tokens cannot expose any Source Library branch or revive retired exports.
18. Source Library share targets are explicitly owner-bound, share operations pin
    the reviewed item revision, and audience labels remain provider-managed rather
    than verified ACL claims.
19. Source Library publication and revocation are proven by the reconciled target
    artifact state. Creating or deleting only a SQLite share row is never sufficient.
20. Source Library SQLite contains no plaintext file paths, titles, recipient
    emails, provider identifiers, document bytes, extracted text, or raw hashes.
21. Source Library ciphertext uses both the active vault key and the profile-bound
    device-custody secret; wrong profile, user, device, purpose, or AAD fails closed.
22. Missing device custody with existing Source Library ciphertext reports recovery
    required and never silently creates a replacement key. Lock, revocation,
    profile change, and disconnect zeroize custody; disconnect also removes the
    local Source Library plane after confirmation.
23. A completed V2 custody migration rejects replayed V1 envelopes. The Keychain
    item is verified on signed macOS with Data Protection Keychain,
    `WhenUnlockedThisDeviceOnly`, non-synchronizable, and local-user-presence
    semantics. It is not described as Secure Enclave storage without a
    non-exportable `SecKey` implementation.

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
