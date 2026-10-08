"""Pure recommendation-signal primitives for One Location.

The service owns recipient authority, source reads, and ranking decisions.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def recommendation_signal() -> dict[str, Any]:
    return {
        "score": 0,
        "reasons": {},
        "needs_action": False,
        "trusted": False,
        "professional": False,
        "relationship_type": None,
        "profile_headline": None,
        "verification_badge": None,
        "last_interaction_at": None,
    }


def signal_time_value(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, datetime):
        parsed = value
    else:
        raw = str(value).strip()
        if not raw:
            return 0.0
        if raw.endswith("Z"):
            raw = f"{raw[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError:
            return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).timestamp()


def safe_recommendation_text(value: Any, *, max_length: int = 96) -> str | None:
    text = " ".join(str(value or "").split())
    if not text:
        return None
    if len(text) <= max_length:
        return text
    return f"{text[: max_length - 1].rstrip()}..."
