"""OAuth authorization-server metadata addresses (RFC 8414 section 3)."""

from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit


def authorization_server_metadata_url(issuer: str) -> str:
    """Insert the well-known segment before an issuer's optional path."""
    parts = urlsplit(issuer)
    if parts.scheme != "https" or not parts.netloc or parts.query or parts.fragment:
        raise ValueError("Invalid authorization-server issuer")
    path = "/.well-known/oauth-authorization-server" + parts.path.rstrip("/")
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))
