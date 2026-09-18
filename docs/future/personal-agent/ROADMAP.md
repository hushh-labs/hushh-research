# Private-agent remaining roadmap

## Status

Reviewed 2026-09-10. Future requirements only; this replaces the July M1–M14 execution schedule. Old dates, billion-user estimates, blanket “flag-off” claims and completed foundation work are retired.

The [direct-runtime handoff](./OWNER-POD-DIRECT-RUNTIME-HANDOFF-2026-09-10.md) owns the next dev milestone. The [north star](../../reference/architecture/private-agent-north-star.md) and [completion ledger](../../../config/pod-completion-ledger.yaml) own requirements and completion evidence.

## Visual Context

See the [private-agent documentation map](./README.md#visual-map).

## Next milestone

Complete app ↔ owner pod ↔ Puppy without mandatory hub involvement in each owner-local request or session renewal. Reuse One, ADK, the shared fleet, provider adapters, consent contracts, PKM and encrypted recovery. Existing hub-mediated inference is a baseline, not acceptance of this direct path.

Follow the handoff's ordered work and stopping rules. No main promotion, UAT/production deployment, Redis dependency, second router or new memory authority belongs to this milestone.

## Requirements retained beyond the immediate handoff

These are deferred or need verification, not automatically missing code. Reinspect their owner before implementation.

| Requirement | Carry-forward boundary and promotion evidence |
| --- | --- |
| Generalized hosted and user-GCP lifecycle (former M6) | One runtime, isolated identities and custody. Prove supported enrollment, provisioning, replacement, erasure and cleanup in each hosting mode; a single owner's deployment is insufficient. |
| First-run experience and provisioning feed | Existing lifecycle/status/feed contracts must report actual readiness and failures. Prove interrupted signup and account switching. App launch must not silently purchase or provision infrastructure. |
| Local-first onboarding proposal | The old vault-last sequence and persistent browser-key proposal are not approved implementation instructions. Reconcile with current vault/PKM ownership, consent and key-continuity rules before adopting; never migrate records into PKM without required authority. |
| Fleet operations and rollout (former M11/M12) | Measure capacity, cost attribution, reconcile behavior and bounded overload; prove compatible rollback and recovery before broader cohorts. No invented SLOs or billion-user estimates. |
| Attestation and regulated deployment (former M5/M13) | Verify key-release attestation and applicable external assurance before any confidentiality or compliance claim. Cloud provider posture alone does not certify this application. |
| Alternative compute / Anypoint (former M7) | Deferred portability option. Require verified API access, capacity, custody and real lifecycle evidence before selecting it as a default or claiming economic advantage. |
| External correction workflows (former M8) | Keep explicit confirmation and scoped authority; require actual external-system settlement and receipts. |
| Device background continuity (former M9) | Respect OS lifecycle limits; prove supported resume, disconnect and revocation. No always-awake phone or computer claim. |
| Identity assurance (former M14) | [Identity-assurance design](../identity-assurance/README.md) retains the step-up and authenticator-attestation direction. Existing passkey login does not prove every sensitive action is gated or establish a stronger assurance classification. |
| Migration promotion | Separate authorized release work under [migration governance](../../reference/operations/migration-governance.md). Reconcile manifests, environment contracts and already-applied dev migrations; never copy old migration numbers or replay assumptions. |

## Promotion rule

For each retained requirement, inspect existing owners, repair only verified gaps, run the smallest authoritative checks and attach current deployed evidence where behavior requires it. Update the canonical reference and existing ledger, then remove the completed planning row. Unsupported, unavailable and unverified claims remain visibly incomplete.

Historical implementation receipts remain linked from the [index](./README.md#historical-provenance); they are not a second work queue.
