# Scope commerce migration preservation

These exact source files and the original release manifest preserve the unpublished
branch tail from `ffd69db573f5` before normal integration of main `812974bf4875`.
They are historical evidence and must never be executed.

[The relocation receipt](relocation_receipt.json) maps seven forward/rollback pairs
from 349–355 to active 350–356 without changing SQL bytes. Main’s published 348/349
remain authoritative. Read-only ledger checks found no accepted identities or
baselines in this range on Dev, UAT or production. Existing preservation receipts
remain unchanged. Source composition does not prove replay or deployment.
