# Reviewer PKM Upgrade Contract

Use this procedure for PKM version changes, readable-projection changes, historical-shape proof, or exact reviewer payload evidence. First apply the generic BYOK/session contract in `reviewer-app-testing`; this file adds only PKM-specific gates.

## Deterministic gates before UAT

1. Run the versioned historical corpus through decrypt, transform, occurrence-lineage proof, encrypt, decrypt, comparison, rollback, and comparison again.
2. Include unversioned blobs, segmented domains, sparse and unknown keys, duplicate values, heterogeneous arrays, empty containers, finance statements, Plaid, KYC, Gmail-derived records, private scopes, and retired aliases.
3. Require zero unmapped, changed, or type-mismatched occurrences. Conflicting or unknown information goes to encrypted quarantine; it is never silently dropped.
4. Require idempotent reruns, coherent content/manifest revisions, unchanged canonical scopes, and successful rollback.
5. Run the structure-agent chain only after deterministic proof; model placement may propose structure but cannot authorize information loss.

## Reviewer app sequence

Real reviewer mutation requires explicit operator authority. When authorized, run:

```bash
PKM_REVIEWER_REHEARSAL_ALLOW_MUTATION=1 \
node .codex/skills/pkm-upgrade-rehearsal/scripts/reviewer-pkm-app-rehearsal.mjs
```

The rehearsal must:

1. authenticate and unlock the canonical reviewer through the shared reviewer harness
2. use same-session Next navigation to load and save sample brokerage information
3. require at least one holding and a successful `financial` domain write
4. preserve canonical `attr.financial.*` and require additive origin metadata `dynamic` / `d` / `manifest_branch`
5. naturally ask the private agent to remember a durable financial preference
6. require the visible `Save to PKM?` review and explicit owner confirmation
7. prove no previously observed canonical scope disappeared
8. fetch one coherent encrypted financial snapshot; browser unlock and protected-route readback remain the default decryption proof
9. close the context, reauthenticate and re-unlock in a fresh context, then require equal encrypted readback and equal vault-key commitment
10. decrypt and write exact payload evidence only when the operator explicitly requests it with `PKM_REVIEWER_REHEARSAL_ALLOW_DECRYPTED_OUTPUT=1`; otherwise the Node harness never derives or decrypts a vault key
11. replace exact output artifacts only after every assertion passes

## Exact artifacts

- `tmp/reviewer-pkm-encrypted-payload.json`: exact final encrypted financial response
- `tmp/reviewer-pkm-decrypted-payload.json`: exact locally decrypted financial domain, only when `PKM_REVIEWER_REHEARSAL_ALLOW_DECRYPTED_OUTPUT=1` is explicitly set

Do not wrap payloads in audit bundles or duplicate samples. Keep runtime output aggregate-only. Write files with mode `0600` and never commit them.

## Upgrade commands

Read-only active-shape audit:

```bash
cd consent-protocol
python3 scripts/audit_active_pkm_shape_readonly.py --env-file .env
```

Historical and contract gate:

```bash
./scripts/ci/pkm-upgrade-gate.sh
```

Gated natural structure-agent chain:

```bash
cd consent-protocol
python3 scripts/eval_pkm_structure_agent.py --phase fresh_chain_60 --env-file .env --enforce-gates
```

Run the mutating app rehearsal last. If the target environment lacks required schema or routes, stop and classify deployment parity; do not apply migrations or change the reviewer fixture without separate authority.
