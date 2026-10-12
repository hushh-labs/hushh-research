"""Exact callback aliases explicitly admitted by this deployment's origin policy."""

from __future__ import annotations

import os
from urllib.parse import urlsplit, urlunsplit


def allowed_oauth_callback_uris(configured: str) -> frozenset[str]:
    """Keep the configured callback and admitted, same-environment domain aliases.

    CORS alone does not authorize arbitrary OAuth destinations. Every extra
    destination has the identical scheme, environment prefix and path, under
    hushh.ai, hussh.ai or hussh.si; both origins must be explicitly admitted.
    Local and custom callbacks retain their existing exact-match behavior.
    """

    allowed = {configured}
    parsed = urlsplit(configured)
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.netloc != parsed.hostname
        or parsed.query
        or parsed.fragment
        or not parsed.hostname
    ):
        return frozenset(allowed)
    host = parsed.hostname
    suffixes = (".hushh.ai", ".hussh.ai", ".hussh.si")
    prefix = next((host[: -len(suffix)] for suffix in suffixes if host.endswith(suffix)), "")
    if prefix not in {"one", "dev.one", "uat.one"}:
        return frozenset(allowed)
    origins = {value.strip() for value in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",")}
    origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    if origin not in origins:
        return frozenset(allowed)
    for suffix in suffixes:
        alias_origin = f"https://{prefix}{suffix}"
        if alias_origin in origins:
            allowed.add(f"{alias_origin}{parsed.path}")
    return frozenset(allowed)
