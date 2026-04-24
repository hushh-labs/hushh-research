# Professional Verification Policy


## Visual Context

Canonical visual owner: [IAM Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose

Define the hard-gate rules for regulated professional access before investor data, discovery, or client-linking workflows become available.

## Official Registry Rules

1. Treat the name-first RIA Intelligence Stage 1 lookup as the default advisory admission-control gate.
2. Treat broker verification as a separate capability with its own official verification lane.
3. Use public BrokerCheck fallback only for evidence gathering when official broker verification is not configured; it must not activate live broker capability.
4. Keep verification fail-closed in production when a terminal advisory decision cannot be produced.

## Capability State Model

1. `draft`
2. `submitted`
3. `verified`
4. `active`
5. `rejected`
6. `bypassed`

## Gate Rules

1. The default RIA flow stays blocked until the advisor name resolves to a verified CRD-backed Stage 1 result.
2. `draft` and `submitted` cannot create investor-data access requests.
3. `verified`, `active`, and `bypassed` can create investor-data access requests only for the advisory lane.
4. `rejected` must resubmit and pass verification.
5. Discoverability is not an admission-control shortcut; it can be enabled only after the advisory lane reaches a trusted state.
6. Brokerage evidence gathered from public fallback must never unlock live brokerage capability.

## Verification Data Contract

1. `display_name`
2. `individual_legal_name`
3. `individual_crd`
4. `advisory_firm_legal_name`
5. `advisory_firm_iapd_number`
6. `verification_provider=ria_intelligence_stage1`
7. `suggested_names`
8. `reason_if_not_verified`
9. `broker_firm_legal_name`
10. `broker_firm_crd`
11. `advisory_status`
12. `brokerage_status`
13. `verification_checked_at`
14. `verification_expires_at`

## Freshness and Runtime Controls

1. Cache successful advisory and broker verification responses with TTL.
2. Re-verify on identity edits that affect names, CRD, or firm identifiers.
3. Re-verify after TTL expiry.
4. Re-verify on final onboarding submit before any advisory access is granted.
5. In production, startup must fail if advisory bypass is enabled or the Stage 1 RIA intelligence verifier is not configured.
6. In non-production, bypassed results must be explicitly labeled as bypassed and auditable.
