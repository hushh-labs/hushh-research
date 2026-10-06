# Consent-audit integrity — tamper-evident receipt chain (AU-9 / AU-10)

**Status:** in pursuit. Feature flag `CONSENT_AUDIT_CHAIN_ENABLED` (default
off) is **on in dev only** (`scripts/deploy/backend-deploy.sh`) and off in uat and
production. Migrations `904` and `913` are **parked** dev-only
(`db/dev_migration_manifest.json`, never `db/release_migration_manifest.json`).
Dev holds **no audit signing key** as of 2026-10-06, so dev writes no receipts
today and every verification answers `signed: false`.

## Visual Context

Canonical visual owner: [consent-protocol reference index](./README.md).

## Why

The primary consent ledger (`consent_audit`) is event-sourced and each consent
token is HMAC-signed, but the **table itself is mutable** (rows carry an
updatable `revoked_at`) and **unchained** — so a silent edit or delete of an
audit row is not detectable from the row alone. For the FedRAMP-High / federal
posture that is the gap against **NIST 800-53 AU-9 (protection of audit
information)** and **AU-10 (non-repudiation)**.

This adds the missing tamper-evidence **without changing the operational consent
write path**, reusing the construction already proven by the Preference
Subscription Fabric ledger (`fabric_receipts_service`, migration 119).

## How it works

On every consent event, `append_consent_receipt_safe` mirrors the event into an
append-only, **per-subject** hash chain in `consent_audit_receipts`:

```
hash      = sha256( prev_hash || "\n" || canonical_payload )
signature = "ed25519.<kid>." + Ed25519( CONSENT_AUDIT_ED25519_PRIVATE_KEY, hash )
```

The audit key is its own namespace (`token_signing.CONSENT_AUDIT`), deliberately
separate from both `APP_SIGNING_KEY` and the consent-token key: the key that mints
a permission must not also sign the record of having minted it. Verifiers hold
only `CONSENT_AUDIT_ED25519_PUBLIC_KEYS`. There is no HMAC fallback: with no audit
key the chain writes nothing and logs `consent_audit_chain_unsigned` per event.

- **Chain** — each receipt links to the previous by `prev_hash`; a dropped,
  inserted, or reordered event breaks the chain.
- **Signature** — each receipt is independently tamper-evident.
- **Serialization** — appends for a subject are serialized with a
  transaction-scoped `pg_advisory_xact_lock`, so concurrent events cannot fork
  the chain.
- **Verification** — `ConsentAuditChainService.verify_chain(subject_id)` (and the
  pure, DB-free `verify_receipts`, exposed as `GET /api/consent/receipts/verify`)
  replays the chain and reports the first break with a reason (`seq_gap`,
  `prev_hash_mismatch`, `hash_mismatch`, `signature_mismatch`). Verification is
  strict: an untagged (HMAC) signature fails as `signature_mismatch`.
- **Explicit verdict**: every verification result carries `signed` (true only
  for a non-empty chain whose every receipt passed strict Ed25519 verification),
  `chain_enabled`, `signing_key_configured`, `signing_kid`, and the kids actually
  found in verified signatures. When `signed` is false, `unsigned_reason` is one
  of `verification_failed`, `chain_disabled`, `signing_key_missing`,
  `no_receipts`. An empty chain is never reported as signed.

## Fail-safe by design

The mirror **never blocks** the operational consent write. When the flag is off
the consent path is byte-for-byte unchanged. When on, a chain-append failure is
logged for reconcile and surfaces as a gap `verify_chain` flags — it does **not**
fail the consent event. Availability of the audit operation is never traded for
the integrity layer.

## Startup guard

A uat or production hub with the chain enabled refuses to start
(`hushh_mcp/consent/audit_signing.py`, run from `hushh_mcp/config.py`) unless the
audit private key is usable, any published `CONSENT_AUDIT_ED25519_PUBLIC_KEYS` map
parses and contains `CONSENT_AUDIT_ED25519_KID`, and a probe signature verifies
against the published key. Dev and local log the same condition at ERROR and keep
serving. Pods are verifier-only and exempt. A lane with the chain off needs no key.

## Enabling (dev)

1. Migrations `904` and `913` apply through the dev-only migration lane.
2. Mint the audit keypair (generated in one process, seed piped to Secret Manager
   over stdin, only the kid and public half printed):
   `uv run python scripts/ops/mint_consent_ed25519_key.py --project hushh-pda-dev --namespace audit`
3. Redeploy dev. `backend-deploy.sh` binds both secrets and sets
   `CONSENT_AUDIT_SIGNING_ALG=ed25519`, `CONSENT_AUDIT_ED25519_KID=hushh-audit-dev-1`
   only when both secrets exist, so deleting them and redeploying is the rollback.
4. Confirm `signed: true` from `GET /api/consent/receipts/verify` for a subject
   with a fresh consent event.

Rotating: `--namespace audit --rotate --kid <new>` adds the new public key beside
the old ones, and the kid literal in `backend-deploy.sh` must move with it.

## Legacy HMAC receipts on dev (known, permanent per subject)

From the dev deploy of 2026-08-26 ~23:00Z (`3debb78b6`, chain on, signed with
`APP_SIGNING_KEY`) to the dev deploy of 2026-09-01 ~05:30Z (`fca1ac47a`,
Ed25519 only), any consent event on dev wrote an HMAC-signed receipt. Strict
verification rejects those rows at their position (normally `seq` 1), and
`append` continues each subject's existing head, so a subject with such a row
reports `signed: false`, `unsigned_reason: verification_failed` for good, even
after the audit key is minted. That is the correct verdict, not a defect.
Whether any such rows exist was not measured (no read path without the database
password). Check read-only before minting:

```sql
SELECT ledger, count(DISTINCT subject_id) AS subjects, count(*) AS receipts,
       min(created_at) AS first_at, max(created_at) AS last_at
FROM consent_audit_receipts
WHERE signature NOT LIKE 'ed25519.%'
GROUP BY ledger;
```

If it returns rows, archiving or resetting those dev chains is a founder
decision; nothing in code rewrites them.

## Honest limitations (what this is NOT — yet)

- **Best-effort, not same-transaction atomic.** The live consent write goes
  through the Supabase client while the chain uses the asyncpg pool, so the
  receipt is appended right after the consent row rather than in one transaction.
  A crash in the gap leaves a detectable chain gap, not a silent loss. A future
  hardening moves the consent write onto asyncpg (or a transactional outbox) for
  strict atomicity.
- **Two ledgers, one table.** Person-visible consent events chain on the
  `consent` ledger; the agent's own internal operations chain on a separate
  `internal` sequence per subject (migration `913`), so the head an owner pins
  does not advance on every turn.
- **The primary `consent_audit` table stays mutable.** This adds an independent
  tamper-evident record to detect tampering; making the primary table itself
  append-only / WORM is a separate, larger step.
- **Signing key custody.** Integrity is only as strong as the custody of
  `CONSENT_AUDIT_ED25519_PRIVATE_KEY` in Secret Manager. Moving it into GCP KMS
  (asymmetric signing, SC-12 / SC-28) is the paired agency-spine step.

Posture stays **"in pursuit"** — the control is real in code before any 3PAO /
ATO says otherwise; it is never presented as a held certification.
