"""Exact callback aliases explicitly admitted by this deployment's origin policy."""

from __future__ import annotations

import os
from urllib.parse import urlsplit, urlunsplit


def mcp_oauth_callback(origin: str, *, environment: str) -> str:
    """The shared and private runtimes use one deployment-owned MCP return rule."""
    parsed = urlsplit(origin)
    local = environment in {"development", "test"} and parsed.hostname in {"localhost", "127.0.0.1"}
    callback = validated_frontend_callback(origin, "/one/profile/connectors/oauth/return")
    if (
        not parsed.hostname
        or not callback
        or (parsed.scheme != "https" and not (local and parsed.scheme == "http"))
    ):
        raise ValueError("Connector return address is not configured.")
    return callback


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
