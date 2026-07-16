# PKM Upgrade Rehearsal

Use this workflow for any PKM contract or readable-projection upgrade that could change stored user information or its consumers.

## Goal

Reach zero unmapped, changed, type-mismatched, unauthorized, incoherent, or unrecoverable information before enabling upgrade writes.

## Steps

1. Route through `security-audit` and select `pkm-upgrade-rehearsal`.
2. Inventory supported versions, shapes, scopes, grants, exports, projections, and compatibility readers.
3. Run the historical decrypt-transform-prove-encrypt-decrypt-rollback corpus.
4. Require occurrence-level lineage and quarantine every unresolved conflict.
5. Run the read-only reviewer shape audit and structure-agent chain.
6. Verify target-environment schema and route parity.
7. Obtain explicit authority before any shared reviewer mutation.
8. Apply the `reviewer-app-testing` BYOK/session contract and run the domain app rehearsal last.
9. Stop on any preservation, scope, authorization, coherence, export, or rollback failure.

## Common Drift Risks

1. A model-proposed structure is mistaken for deterministic preservation proof.
2. A scope-origin marker changes a canonical authorization string.
3. A deployment gap is “fixed” by an unauthorized migration or fixture mutation.
4. Exact encrypted/decrypted payloads are wrapped, duplicated, logged, or written outside private `tmp/` evidence.
