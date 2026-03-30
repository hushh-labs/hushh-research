# PKM Cutover Runbook


## Visual Context

Canonical visual owner: [Architecture Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This is the bounded runbook for cutting Kai from legacy encrypted storage to PKM.

## Preconditions

- PKM schema is applied in the target environment.
- Backend serves `/api/pkm/*`.
- Frontend uses the PKM service path.
- Agent Lab works with an authenticated user and unlocked vault.
- Kai financial regression smoke is green.

## Local/UAT drill user

- `KAI_TEST_USER_ID=s3xmA4lNSAQFrIaOytnSGAOzXlL2`
- passphrase is stored only in ignored local/UAT env files and secret storage
- never commit the real passphrase into tracked examples or production env

## Migration drill

1. Unlock the test user's vault with the passphrase wrapper.
2. Read the legacy encrypted payload.
3. Decrypt locally.
4. Repartition each top-level domain into PKM segments.
5. Write:
   - `pkm_blobs`
   - `pkm_manifests`
   - `pkm_manifest_paths`
   - `pkm_scope_registry`
   - `pkm_index`
   - `pkm_events`
   - `pkm_migration_state`
6. Verify Kai financial behavior still matches pre-cutover behavior.
7. Verify consent export still works for `pkm.read` and `attr.financial.*`.

## Production cutover rules

- Do not attempt server-side repartition of BYOK ciphertext.
- Keep the migration adapter time-boxed.
- Delete legacy adapters and tables only after the unlock migration window closes.
- Treat production separately from UAT because runtime posture is different.

## Important boundary: cutover vs generic upgrades

Legacy cutover and ongoing PKM evolution are different:

- `pkm_migration_state` is only for the bounded legacy-to-PKM repartition window.
- Ongoing PKM schema/readability evolution uses resumable `pkm_upgrade_runs` + `pkm_upgrade_steps`.
- Generic PKM upgrades still happen client-side after unlock:
  1. detect stale model/domain/readable versions
  2. decrypt one encrypted domain locally
  3. transform it to the current contract
  4. rebuild manifests/readable metadata
  5. re-encrypt and store with optimistic concurrency
- If the app is interrupted, resume is allowed only after local vault re-auth. There is no silent server-side decrypt or key recovery.

## Wrapper selection rule

Migration tooling must never choose "latest wrapper wins".

Correct behavior:

- choose the explicit wrapper id when provided
- otherwise choose the actual unlock method
- when using a passphrase drill, choose the `passphrase` wrapper
