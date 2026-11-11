"""Opaque choice refs for a draft question between several connections.

"Both" or "all" can't be said with a name that several connections share, so a
question offers one ref per connection. A ref is bound to the owner and the
connection, carries no address, and is checked by recomputing it over the
owner's current connections; nothing is stored.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

CHOICE_REF = re.compile(r"rc_[0-9a-f]{16}")
CHOICES_TAIL = (
    " If they mean more than one of them, call again with each chosen ref in "
    "recipient_choices; never say a ref."
)


def choice_ref(owner: str, row: dict[str, Any]) -> str:
    """The owner-bound ref for one connection row."""
    key = f"{owner}\x1f{row.get('connectionId') or ''}".encode()
    return "rc_" + hashlib.sha256(key).hexdigest()[:16]


def parse_choice_refs(value: str) -> list[str] | None:
    """Comma-separated refs once each, or None when any is not a ref."""
    refs = list(dict.fromkeys(ref.strip() for ref in value.split(",") if ref.strip()))
    return refs if all(CHOICE_REF.fullmatch(ref) for ref in refs) else None
