"""The plaintext envelope of a ``secrets`` domain write.

The Secrets area holds API keys, passwords, tokens and card and government id
numbers. The encrypted blob is ciphertext the server cannot read (BYOK), so the
plaintext ``summary`` beside it is the one place a faulty client could leak a
secret, or even its label, onto the server. This refuses that outright, the
same posture as ``validate_wallet_card_envelope``.

Allowed: bookkeeping scalars only (versions, timestamps, flags, ``item_count``).
Refused: any item, label or value key at any depth; any nested object or list;
any string carrying whitespace (human text such as a label) or a secret span.
"""

from __future__ import annotations

import re
from typing import Any

from hushh_mcp.consent.secret_patterns import find_secret_spans

_FORBIDDEN_KEYS = frozenset(
    {"items", "item", "label", "labels", "value", "values", "secret", "secrets", "kind"}
)
_MACHINE_TEXT = re.compile(r"^[A-Za-z0-9_.:+-]{0,64}$")
MAX_SECRETS_PER_OWNER = 5000


def validate_secrets_summary_envelope(summary: Any) -> None:
    """Raise ``ValueError`` unless ``summary`` is a bookkeeping-only envelope."""
    if not isinstance(summary, dict):
        raise ValueError("secrets_summary_must_be_object")
    for key, value in summary.items():
        normalized = str(key).strip().lower()
        if normalized in _FORBIDDEN_KEYS:
            raise ValueError(f"secrets_summary_forbidden_key:{normalized}")
        if isinstance(value, dict | list | tuple):
            raise ValueError(f"secrets_summary_nested_value:{normalized}")
        if isinstance(value, str) and (
            not _MACHINE_TEXT.fullmatch(value) or find_secret_spans(value)
        ):
            raise ValueError(f"secrets_summary_text_value:{normalized}")
    item_count = summary.get("item_count")
    if item_count is not None and (
        isinstance(item_count, bool)
        or not isinstance(item_count, int)
        or not 0 <= item_count <= MAX_SECRETS_PER_OWNER
    ):
        raise ValueError("secrets_summary_item_count_invalid")


__all__ = ["MAX_SECRETS_PER_OWNER", "validate_secrets_summary_envelope"]
