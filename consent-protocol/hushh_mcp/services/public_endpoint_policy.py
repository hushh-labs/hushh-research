"""Import-safe public HTTPS policy shared by MCP and sandbox browser validation."""

from __future__ import annotations

import ipaddress
from urllib.parse import urlsplit


class UnsafeMcpEndpoint(ValueError):
    def __init__(self) -> None:
        # Do not include a possibly credential-bearing URL or DNS response.
        super().__init__("The connector requires a public HTTPS endpoint.")


def _public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if not ip.is_global or ip.is_multicast or ip.is_reserved or "%" in address:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        # Transition encodings can tunnel to a different IPv4 destination.
        return (
            ip.ipv4_mapped is None
            and ip.sixtofour is None
            and ip.teredo is None
            and ip not in ipaddress.ip_network("64:ff9b::/96")
            and ip not in ipaddress.ip_network("64:ff9b:1::/48")
        )
    return True


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
        if "." not in host or host.rstrip(".").lower().endswith(
            (".localhost", ".local", ".internal")
        ):
            raise UnsafeMcpEndpoint()
    else:
        if not _public_address(host):
            raise UnsafeMcpEndpoint()
