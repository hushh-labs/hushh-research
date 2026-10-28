"""Read a still-valid cached Google bearer without changing its grant."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import Any


def cached_bearer(
    row: Mapping[str, Any],
    *,
    aad: str,
    force_refresh: bool,
    decrypt: Callable[..., str],
    now: Callable[[], datetime],
) -> str | None:
    expiry = row.get("access_token_expires_at")
    try:
        if (
            not force_refresh
            and expiry
            and datetime.fromisoformat(str(expiry).replace("Z", "+00:00"))
            > now() + timedelta(seconds=90)
        ):
            return decrypt(
                {
                    "ciphertext": row.get("access_token_ciphertext"),
                    "iv": row.get("access_token_iv"),
                },
                aad=aad,
            )
    except ValueError:
        pass
    return None
