"""Read-only cutover contract for the legacy server-side Gmail receipt cache.

Legacy rows remain readable so existing people do not lose their receipt history.
No server path may add or update receipt rows or receipt-memory artifacts while
the device-owned Gmail reader is being introduced.
"""

from __future__ import annotations

from typing import Final, Literal

GmailReceiptStorageMode = Literal["legacy_read_only"]

GMAIL_RECEIPT_STORAGE_MODE: Final[GmailReceiptStorageMode] = "legacy_read_only"
GMAIL_RECEIPT_CUTOVER_MESSAGE: Final = (
    "Receipt sync is moving to private on-device processing. Existing receipts remain available."
)


class GmailReceiptStorageCutoverError(RuntimeError):
    """Raised when code attempts to create or mutate retired receipt cache data."""


def receipt_storage_status() -> dict[str, object]:
    """Return the public, value-free storage posture for Gmail status responses."""

    return {
        "receipt_storage_mode": GMAIL_RECEIPT_STORAGE_MODE,
        "receipt_sync_available": False,
        "receipt_storage_message": GMAIL_RECEIPT_CUTOVER_MESSAGE,
    }


def receipt_storage_writes_enabled() -> bool:
    """Keep the runtime gate explicit for the later device-owned reader rollout."""

    return False


def require_receipt_storage_write() -> None:
    """Fail closed before any legacy receipt-cache or artifact write."""

    raise GmailReceiptStorageCutoverError(GMAIL_RECEIPT_CUTOVER_MESSAGE)
