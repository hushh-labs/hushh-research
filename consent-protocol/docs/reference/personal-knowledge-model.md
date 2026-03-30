# Personal Knowledge Model


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

The Personal Knowledge Model (PKM) is Kai's canonical user-memory architecture.

## Canonical tables

- `pkm_index`
  Discovery-only metadata. No semantic private state.
- `pkm_blobs`
  Encrypted PKM payload segments keyed by `user_id + domain + segment_id`.
- `pkm_manifests`
  Private encrypted-first structure metadata per user/domain.
- `pkm_manifest_paths`
  Private queryable manifest paths for first-party runtime and consent expansion.
- `pkm_scope_registry`
  Public queryable scope handles and coarse exposure metadata. No raw internal PKM paths should be exposed outside first-party authenticated tooling.
- `pkm_events`
  Append-only PKM mutation and replay ledger.
- `pkm_migration_state`
  Cutover state for legacy encrypted users awaiting repartition on vault unlock.
- `pkm_upgrade_runs`
  Generic client-side PKM upgrade runs for post-cutover schema and readability evolution.
- `pkm_upgrade_steps`
  Per-domain resumable checkpoints for generic PKM upgrades. No plaintext or key material is stored here.

## Storage rules

- New writes are PKM-only.
- Encrypted payloads are segmented by top-level domain and segment id.
- Payload ciphertext remains opaque:
  - `ciphertext`
  - `iv`
  - `tag`
  - `algorithm`
  - `content_revision`
  - `manifest_revision`
  - `size_bytes`
- Exact raw JSON paths remain private to first-party authenticated tooling after vault unlock.
- Public/runtime discovery must use scope handles and coarse metadata, not raw internal PKM paths.

## Why JSONB is not the encrypted payload layer

We explicitly reject `jsonb { plaintext_key: ciphertext_value }` as the primary PKM storage model.

Why:

- it leaks semantic PKM structure
- it weakens the zero-knowledge posture
- it increases write amplification
- it complicates nested object and array storage
- it does not make encrypted value queries meaningfully better

JSONB is still useful for:

- `pkm_index.summary_projection`
- manifest metadata
- scope registry metadata
- sanctioned counters and capability flags

## Retrieval path

1. Read `pkm_index` for discovery and freshness.
2. Resolve allowed scope handles through `pkm_scope_registry`.
3. Fetch only the required `pkm_blobs` segments.
4. Decrypt only those segments in the authenticated trusted boundary.
5. Cache decrypted segments by `user + domain + segment + content_revision`.

The server does not inspect plaintext PKM payloads.

## Generic PKM upgrades

After legacy cutover, PKM still evolves. Those upgrades are a separate system from `pkm_migration_state`.

- `pkm_migration_state` remains only for legacy-to-PKM repartition.
- Generic PKM upgrades are driven by:
  - global `pkm_index.model_version`
  - per-domain `pkm_manifests.domain_contract_version`
  - per-domain `pkm_manifests.readable_summary_version`
- The client plans upgrades after vault unlock, decrypts locally, rewrites one domain at a time, re-encrypts, and stores new PKM rows with optimistic concurrency.
- Upgrade run state and checkpoints are stored server-side as non-secret metadata only.
- If the app loses the unlocked session mid-upgrade, the next resume must reacquire access locally through the user’s normal vault unlock method.

## Financial protected lane

Kai Finance remains a protected mature PKM domain during cutover.

Protected behaviors:

- onboarding
- Plaid
- portfolio import
- dashboard
- debate
- optimize
- analysis history

Freeform chat must not invent arbitrary new canonical financial structures that conflict with the governed financial contract.

## Migration truth

Legacy encrypted storage can only be fully repartitioned after a user unlocks their vault at least once.

Cutover sequence:

1. Fresh users write PKM only.
2. Legacy metadata is backfilled into `pkm_index`.
3. Legacy users are marked `awaiting_unlock_repartition`.
4. On next authenticated vault unlock, the client decrypts the legacy blob, repartitions it into PKM segments, re-encrypts, writes PKM rows, and marks migration complete.
5. After the bounded migration window, legacy tables and adapters are deleted.

Legacy names survive only inside migration internals and must not be used for new product work.
