"""The owner's saved receipt index, carried into one typed chat turn.

This server never holds the vault key. The owner's device decrypts
``shopping.receipts_memory`` and sends its bounded canonical index beside a
typed turn so the Email specialist can answer "show my receipts" from the
owner's own saved memory instead of searching the inbox.

The server validates the index against a closed schema, keeps it only in the
process-local expiring request store, and gives ADK state an opaque ``temp:``
reference, so it is never persisted as conversation state and never logged.
It grants no authority: the only reader is the Email receipts read, which
filters, pages and formats it and calls no model and no mailbox.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from hushh_mcp.one_adk.request_secrets import resolve_request_secret, store_request_secret
from hushh_mcp.services.receipt_memory_read import parse_receipt_index

logger = logging.getLogger(__name__)

STATE_RECEIPT_MEMORY = "temp:hussh:receipt_memory"
FORWARDED_KEY = "receiptMemory"


def admit_receipt_memory(forwarded: dict) -> str:
    """Remove ``receiptMemory`` from forwarded props; return an expiring reference.

    Popped before the bridge can copy or serialize forwarded props. An index that
    does not match the closed schema is treated as absent rather than repaired or
    allowed to fail the person's turn; a receipts question then answers "not ready".
    The stored value is the validated, sanitized form, never the raw request body.
    """
    value = forwarded.pop(FORWARDED_KEY, None)
    if value is None:
        return ""
    index = parse_receipt_index(value)
    if index is None:
        # Bounded label only: the rejected body can hold purchase details.
        logger.info("one.receipt_memory_rejected reason=invalid_index")
        return ""
    return store_request_secret(index.model_dump_json(by_alias=True))


def resolve_receipt_memory(state_getter: Any) -> dict | None:
    """The admitted index as a plain mapping, or ``None`` when none was admitted."""
    raw = state_getter(STATE_RECEIPT_MEMORY) if callable(state_getter) else None
    text = resolve_request_secret(raw)
    if not text:
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


__all__ = [
    "FORWARDED_KEY",
    "STATE_RECEIPT_MEMORY",
    "admit_receipt_memory",
    "resolve_receipt_memory",
]
