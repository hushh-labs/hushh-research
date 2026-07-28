# Consent-audit integrity — tamper-evident receipt chain (AU-9 / AU-10)

**Status:** in pursuit, dev-branch only, feature-flagged **OFF**
(`CONSENT_AUDIT_CHAIN_ENABLED`, default off). Migration `904` is **parked**
(900 band, not in `db/release_migration_manifest.json`) until greenlit. Nothing
in a released environment changes until the flag is turned on.

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
signature = HMAC-SHA256( APP_SIGNING_KEY, hash )
```

- **Chain** — each receipt links to the previous by `prev_hash`; a dropped,
  inserted, or reordered event breaks the chain.
- **Signature** — each receipt is independently tamper-evident.
- **Serialization** — appends for a subject are serialized with a
  transaction-scoped `pg_advisory_xact_lock`, so concurrent events cannot fork
  the chain.
- **Verification** — `ConsentAuditChainService.verify_chain(subject_id)` (and the
  pure, DB-free `verify_receipts`) replays the chain and reports the first break
  with a reason (`seq_gap`, `prev_hash_mismatch`, `hash_mismatch`,
  `signature_mismatch`).

## Fail-safe by design

The mirror **never blocks** the operational consent write. When the flag is off
the consent path is byte-for-byte unchanged. When on, a chain-append failure is
logged for reconcile and surfaces as a gap `verify_chain` flags — it does **not**
fail the consent event. Availability of the audit operation is never traded for
the integrity layer.

## Enabling (dev only)

1. Apply migration `904_consent_audit_receipts.sql` (still parked; renumber into
   sequence + add to the release manifest at greenlight).
2. Set `CONSENT_AUDIT_CHAIN_ENABLED=1`.
3. Confirm with `verify_chain` over a known subject after a few consent events.

## Honest limitations (what this is NOT — yet)

- **Best-effort, not same-transaction atomic.** The live consent write goes
  through the Supabase client while the chain uses the asyncpg pool, so the
  receipt is appended right after the consent row rather than in one transaction.
  A crash in the gap leaves a detectable chain gap, not a silent loss. A future
  hardening moves the consent write onto asyncpg (or a transactional outbox) for
  strict atomicity.
- **Covers the `consent_audit` primary ledger.** Internal self-activity events
  (`internal_access_events`) are not yet chained — a follow-up.
- **The primary `consent_audit` table stays mutable.** This adds an independent
  tamper-evident record to detect tampering; making the primary table itself
  append-only / WORM is a separate, larger step.
- **Signing key custody.** Integrity is only as strong as `APP_SIGNING_KEY`
  custody. Moving that key into GCP KMS (envelope encryption + rotation, SC-12 /
  SC-28) is the paired agency-spine step.

Posture stays **"in pursuit"** — the control is real in code before any 3PAO /
ATO says otherwise; it is never presented as a held certification.
