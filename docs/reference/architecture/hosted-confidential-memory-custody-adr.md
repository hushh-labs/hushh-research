# ADR: Proposed hosted Confidential Space memory runtime and key custody

Status: **Proposed for explicit owner review; not implemented or enabled.**
Updated: 2026-10-14.

## Context and decision boundary

Today the owner client can refresh Live Memory only while open and unlocked.
The backend stores the existing PKM ciphertext and does not receive the
canonical vault key. The proposed event journal, replay worker and hosted
runtime are absent. [The freshness ADR](./living-memory-freshness-adr.md)
describes the implemented boundary and the earlier owner-operated device
proposal.

The owner selected a **hosted private runtime** as the direction for a future
opt-in review. A normal Cloud Run worker with Cloud KMS decrypt permission
would receive the decrypted data key in its process; Cloud KMS encryption at
rest alone would change the current zero-knowledge custody promise without
isolating the runtime from the operator. This ADR proposes a narrower pilot on
an isolated Google Confidential Space VM. It is a **change in key custody**:
the approved workload could hold a scoped plaintext memory key and source
values in protected VM memory. It is not a claim that Hussh or Google can never
access plaintext, that a TEE is infallible, or that the current app operates
while closed.

Google describes Confidential Space as an attested Confidential VM workload
whose resource owner can condition access on workload assertions such as the
container image digest. Its security overview also names exclusions including
some software supply-chain and Google Cloud attacks. These are design inputs,
not a certification of this application. [Security overview](https://docs.cloud.google.com/docs/security/confidential-space),
[resource grants](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/create-grant-access-confidential-resources).

## Proposed custody protocol

1. **New, scoped content key.** From an unlocked owner client, generate a new
   per-owner memory data-encryption key for specifically selected source
   envelopes. Keep an owner-wrapped recovery copy. For the pilot, the client
   can encrypt that small DEK locally with a pinned Cloud KMS asymmetric
   public key, then release the wrapped copy only after attestation succeeds.
   Only the attested workload identity receives the narrowly scoped
   `asymmetricDecrypt` permission; Cloud KMS returns plaintext to that VM
   process, so this is explicitly hosted key custody. The legacy canonical
   vault key is never imported or sent to the
   hosted runtime. Existing ciphertext cannot be decrypted merely by deriving
   an HKDF child key; selected domains need a versioned envelope migration,
   readback verification and rollback before any hosted read is possible.
   [Cloud KMS asymmetric envelope guidance](https://docs.cloud.google.com/kms/docs/asymmetric-encryption).
2. **Owner-verified enrollment.** Show the source list, allowed read/write
   operations, expected image digest, key-custody change, retention and
   revocation limits before an explicit opt-in. The unlocked client verifies a
   fresh, nonce-bound attestation for the expected production Confidential
   Space image, immutable workload digest and approved launch settings, and
   binds the evidence to the encrypted client-to-workload channel before
   releasing the runtime-wrapped key. Google documents custom audience/nonces
   and TLS channel binding for external relying parties.
   [External resource attestation](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/connect-external-resources),
   [attestation assertions](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/attestation-assertions).
3. **Narrow hosted release.** Run a single-purpose immutable workload image on
   an isolated Confidential Space VM. Its federated workload identity has only
   the KMS decrypt and ciphertext/source metadata rights needed for this
   pilot. Pin the image digest and production, debug-disabled attestation
   claims; reject overrides and unsupported or revoked runtime images. Use
   direct resource access rather than a broadly impersonated service account
   where supported. Keep KMS policy administration separate from deployment
   administration. A new workload digest needs an explicit owner-visible
   policy and enrollment transition, not a silent moving-tag update.
   [Resource access guidance](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/create-grant-access-confidential-resources),
   [attestation assertions](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/attestation-assertions).
4. **Constrained processing.** The workload consumes only consented encrypted
   journal events and authoritative owner snapshots, verifies owner identity,
   source revisions and freshness, then writes derived ciphertext through the
   existing compare-and-swap contract. Checkpoints advance only after commit
   and readback. The pilot makes no model calls and does not answer paid
   requests. Plaintext keys, values, prompts and document bodies stay out of
   disk, serial console, crash dumps, app logs and traces. Emit only source
   kind, opaque counters, revision and health metadata. Network egress,
   runtime permissions and retention remain separately reviewed.
5. **Revocation and recovery.** Revocation denies new leases and source reads,
   removes the runtime-wrapped key, stops the worker, and rotates/re-encrypts
   the scoped key for the surviving owner client. Unpairing and account erasure
   also remove encrypted checkpoints and derived projections under their
   retention contracts. Revocation cannot recall plaintext already present in
   a running VM's RAM, undo prior processing, or prove that a previously
   compromised workload forgot copied data. The UI must disclose this limit
   and show last successful source verification and worker health.

Confidential Space uses attestation tokens and Workload Identity Federation to
authorize access; an attested image digest alone does not supply per-owner
consent, application authorization or key-rotation semantics. Those controls
belong in this protocol and its tests. [Resource access guidance](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/create-grant-access-confidential-resources).

## Pilot gates and evidence

The first pilot uses synthetic keys and synthetic owner records. It must prove
positive and negative attestation decisions (wrong digest, debug image,
expired/replayed nonce, changed TLS channel), KMS deny outside the attested
identity, source/owner isolation, failed-read preservation, crash/replay and
compare-and-swap conflict recovery, scoped rotation, and prompt shutdown on
revocation. Audit **Data Access** logging for Cloud KMS must be explicitly
enabled and verified; it is not enough to assume Admin Activity logs show key
reads. [Google audit configuration](https://docs.cloud.google.com/logging/docs/audit/configure-data-access).

Only after that synthetic gate, a separately approved UAT pilot may enroll one
opted-in owner and one selected source with the versioned envelope. No
production or live vault-key transfer is authorized by this ADR. Release needs
documented owner consent, a reviewed threat model, measured freshness and
capacity, key-policy separation, incident response, exit/migration path, and
an independent security review. If any gate fails, the product continues to
claim only open-and-unlocked Live Memory freshness.
