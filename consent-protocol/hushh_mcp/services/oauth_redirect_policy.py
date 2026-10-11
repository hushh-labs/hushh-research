"""Exact callback aliases explicitly admitted by this deployment's origin policy."""

from __future__ import annotations

import os
from urllib.parse import urlsplit, urlunsplit


def validated_frontend_callback(origin: str, callback_path: str) -> str:
    """Build Gmail's callback only from a complete, environment-owned origin."""
    parsed = urlsplit(origin)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        return ""
    normalized_origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    return f"{normalized_origin}{callback_path}"


def google_compatibility_callback(origin: str, callback_path: str, legacy_redirect: str) -> str:
    """Derive Google's distinct callback before using the retained Gmail fallback.

    The configured Google callback wins in the service before this builder is
    called. Preserve Google's existing origin concatenation independently of
    Gmail's stricter origin validation.
    """
    return f"{origin}{callback_path}" if origin else legacy_redirect


def allowed_oauth_callback_uris(configured: str) -> frozenset[str]:
    """Keep the configured callback and its admitted, same-environment spelling.

    CORS alone does not authorize arbitrary OAuth destinations. The only extra
    destination has the identical scheme, environment hostname and path, with
    hushh.ai/hussh.ai exchanged; both origins must be explicitly admitted.
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
    alias = ""
    for old, new in ((".hushh.ai", ".hussh.ai"), (".hussh.ai", ".hushh.ai")):
        if host.endswith(old):
            prefix = host[: -len(old)]
            if prefix in {"one", "dev.one", "uat.one"}:
                alias = prefix + new
            break
    if not alias:
        return frozenset(allowed)
    origins = {value.strip() for value in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",")}
    origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    alias_origin = f"https://{alias}"
    if origin in origins and alias_origin in origins:
        allowed.add(f"{alias_origin}{parsed.path}")
    return frozenset(allowed)
