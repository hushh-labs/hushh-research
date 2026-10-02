"""Domain-separated keyed digests for the Azure setup, derived from APP_SIGNING_KEY.

One purpose per label, so a value minted for one use (an OAuth state, a resource
name, the setup binding tag) can never verify as another. Parts are joined with a
unit separator they may not contain, so ``("a", "b|c")`` and ``("a|b", "c")`` never
collide.

Rotating APP_SIGNING_KEY changes every digest. Names are recorded, never recomputed,
so a rotation only affects new setups; a setup binding minted before a rotation
stops verifying, which fails closed (attach refuses, a sign-in re-binds).
"""

from __future__ import annotations

import hashlib
import hmac

_SEPARATOR = "\x1f"


def _master() -> bytes:
    from hushh_mcp.runtime_settings import get_core_security_settings  # noqa: PLC0415

    key = get_core_security_settings().app_signing_key
    if not key:
        raise RuntimeError("APP_SIGNING_KEY is required for the Azure setup")
    return key.encode()


def keyed_digest(label: str, *parts: str) -> str:
    """Hex HMAC-SHA256 of ``parts`` under a key derived for ``label``."""
    if not label or any(_SEPARATOR in str(part) for part in parts):
        raise ValueError("keyed digest parts may not contain the separator")
    derived = hmac.new(_master(), f"hussh/azure/{label}/v1".encode(), hashlib.sha256).digest()
    message = _SEPARATOR.join(str(part) for part in parts).encode()
    return hmac.new(derived, message, hashlib.sha256).hexdigest()


def digest_matches(expected_hex: str, label: str, *parts: str) -> bool:
    """Constant-time check of a previously minted digest."""
    return hmac.compare_digest(str(expected_hex or ""), keyed_digest(label, *parts))


__all__ = ["digest_matches", "keyed_digest"]
