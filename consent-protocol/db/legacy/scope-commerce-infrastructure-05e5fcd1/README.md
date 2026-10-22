# Scope commerce migration preservation

These exact source files and the original release manifest preserve the private
migration tail from `05e5fcd17b05` before normal integration of main
`c8faf48dd668`. They are historical evidence and must never be executed.

[The relocation receipt](relocation_receipt.json) maps the seven forward/rollback
pairs from 342–348 to active 349–355 without changing SQL bytes. Original PWM
335 is identical to main’s active PWM 340; main’s Drive 335 remains authoritative.
Existing preservation receipts remain unchanged. Source composition does not
prove database replay, preservation or deployment acceptance.
