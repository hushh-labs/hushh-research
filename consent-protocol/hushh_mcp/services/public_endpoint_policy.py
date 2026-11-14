"""Import-safe public HTTPS policy shared by MCP and sandbox browser validation."""

from __future__ import annotations

import ipaddress
from urllib.parse import urlsplit

from hushh_mcp.services.public_network_address import is_public_address as _public_address


class UnsafeMcpEndpoint(ValueError):
    def __init__(self) -> None:
        # Do not include a possibly credential-bearing URL or DNS response.
        super().__init__("The connector requires a public HTTPS endpoint.")


_BLOCKED_HOST_SUFFIXES = (
    ".localhost",
    ".local",
    ".internal",
    ".metadata.goog",
    ".svc",
    ".cluster.local",
    ".home.arpa",
)
_BLOCKED_EXACT_HOSTS = frozenset({"metadata.goog"})


def validate_mcp_endpoint(endpoint: str) -> None:
    try:
        url = urlsplit(endpoint)
        valid = (
            len(endpoint) <= 4096
            and not any(ord(c) <= 32 or ord(c) == 127 for c in endpoint)
            and "\\" not in endpoint
            and url.scheme == "https"
            and bool(url.hostname)
            and url.username is None
            and url.password is None
            and not url.fragment
            and not url.query
            and url.port in (None, 443)
            and "%" not in (url.hostname or "")
        )
        host = url.hostname or ""
    except ValueError:
        raise UnsafeMcpEndpoint() from None
    if not valid:
        raise UnsafeMcpEndpoint()
    try:
        ipaddress.ip_address(host)
    except ValueError:
        normalized = host.rstrip(".").lower()
        if (
            "." not in normalized
            or normalized in _BLOCKED_EXACT_HOSTS
            or normalized.endswith(_BLOCKED_HOST_SUFFIXES)
        ):
            raise UnsafeMcpEndpoint()
    else:
        if not _public_address(host):
            raise UnsafeMcpEndpoint()
