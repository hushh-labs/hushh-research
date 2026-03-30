# PKM Cutover Runbook


## Visual Map

```mermaid
flowchart TB
  legacy["Legacy world-model ciphertext"]
  unlock["Vault unlock on client"]
  cutover["One-time cutover adapter<br/>legacy -> PKM partitioning"]
  pkm["Encrypted PKM domains<br/>blobs + manifests + index"]
  status["PKM upgrade status<br/>manifest truth + fallback summary drift detection"]
  manifest["Domain manifest contract<br/>paths + scope registry + readable summary"]
  upgrade["Client-side PKM upgrade run<br/>decrypt -> transform -> rebuild -> re-encrypt"]
  rehearsal["Kai test-user no-write rehearsal<br/>decrypt -> transform -> rebuild -> dummy save validate"]
  bell["Bell / PKM lab surface<br/>status + failure metadata + timing"]

  legacy -->|decrypts locally during bounded cutover window| cutover
  unlock -->|gates local decrypt with BYOK key| cutover
  cutover -->|writes encrypted PKM blobs + manifest/index metadata| pkm
  pkm -->|reports stored model/domain versions| status
  manifest -->|defines authoritative domain/readable contract when present| status
  status -->|starts real upgrade only for truly stale domains| upgrade
  status -->|starts no-write rehearsal for Kai local/UAT drill user| rehearsal
  manifest -->|defines current contract + stable UI keys| upgrade
  unlock -->|authorizes resumable generic upgrade| upgrade
  unlock -->|authorizes no-write rehearsal after app entry| rehearsal
  upgrade -->|writes resumable run metadata + upgraded ciphertext| pkm
  rehearsal -->|validates final store payload without DB writes| bell
  upgrade -->|surfaces progress/failure context| bell
```

This is the bounded runbook for cutting Kai from legacy encrypted storage to the Personal Knowledge Model (PKM).

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

## Compatibility gate

Production rollout is blocked unless all supported stored-version paths are green:

1. legacy world-model cutover source -> PKM
2. prior PKM model versions -> current `CURRENT_PKM_MODEL_VERSION`
3. prior domain-contract versions -> current domain contract
4. prior readable-summary versions -> current readable summary

The minimum blocking proof set is:

1. backend manifest route compatibility tests
2. frontend PKM upgrade orchestrator compatibility tests
3. runtime migration audit proving unlock-triggered background upgrade does not break profile/privacy or PKM lab

Manifest fetch failures must be treated as P0:

1. `404` means no manifest yet and can still be a supported compatibility path
2. malformed/legacy manifest rows must normalize into the current response contract
3. true backend failures must surface structured route/domain/stage detail to the bell and PKM lab

## Manifest truth rule

When a domain manifest exists, it is the authoritative source for:

- `domain_contract_version`
- `readable_summary_version`
- `upgraded_at`

Index summary versions remain useful as a fallback when no manifest exists, but stale summary data must not force a false rerun of the PKM upgrade.

## Kai no-write rehearsal rule

For the Kai drill user in local/UAT:

1. enable `NEXT_PUBLIC_PKM_UPGRADE_REHEARSAL=true`
2. sign in and unlock normally
3. let the app start the PKM cycle automatically from app entry
4. the rehearsal runs the real client-side decrypt/transform/rebuild path
5. the final payload is validated through a dummy save route and is never written to the real PKM tables

This is the safe way to measure end-to-end upgrade timing and frontend rendering behavior without mutating the live user record.

The required automated companion for this drill is:

1. [scripts/ci/pkm-upgrade-gate.sh](../../../scripts/ci/pkm-upgrade-gate.sh)
2. it runs the PKM upgrade contract/orchestration suites by default
3. when `PKM_UPGRADE_RUNTIME_AUDIT_BASE_URL` is present, it also runs the live investor onboarding, PKM migration, and RIA onboarding browser audits against that runtime

## Wrapper selection rule

Migration tooling must never choose "latest wrapper wins".

Correct behavior:

- choose the explicit wrapper id when provided
- otherwise choose the actual unlock method
- when using a passphrase drill, choose the `passphrase` wrapper
