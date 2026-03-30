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

## Ecosystem Checks

1. Agents and Operons respect consent scope boundaries.
2. MCP access remains token-scoped.
3. A2A delegation does not escalate scopes.
4. ADK/A2A compliance checks pass.

## Exit Criteria

1. All checklist sections pass.
2. No open P0/P1 IAM defects.
3. Rollback steps are documented.
