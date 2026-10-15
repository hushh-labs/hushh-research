# Scope commerce migration preservation

Exact unpublished source from `866c001ab80f` before integrating main `60a73734ac79`.
Historical evidence only; never execute these files.

The [receipt](relocation_receipt.json) maps forward/rollback pairs from 350–356 to
400–406 with unchanged SQL bytes. Main’s published 350 remains authoritative.
The existing contract permits sorted unique three-digit IDs with gaps; this is a
one-time unused allocation, not a central reservation mechanism. All schema heads
are 406. A later entry below an established baseline changes its checksum and
must still fail until fresh governed baseline qualification; no guard is weakened.
Read-only ledger checks cover both ranges and all baselines in Dev/UAT/production.
Prior archives and preservation receipts remain unchanged. Source composition is
not database replay or deployment proof.
