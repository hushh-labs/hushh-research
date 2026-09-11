"""Canonical remote MCP audience; request headers never establish authority."""

from __future__ import annotations

import os
from urllib.parse import urlsplit


def configured_mcp_origin() -> str | None:
    raw = str(os.getenv("CONSENT_API_PUBLIC_ORIGIN") or "").strip().rstrip("/")
    if not raw:
        return None
    try:
        parts = urlsplit(raw)
        valid_transport = parts.scheme == "https" or (
            parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1", "::1"}
        )
        valid = (
            valid_transport
            and parts.hostname
            and not parts.username
            and not parts.password
            and not parts.path
            and not parts.query
            and not parts.fragment
        )
        _ = parts.port
    except ValueError:
        valid = False
    if not valid or any(character.isspace() for character in raw):
        raise ValueError("CONSENT_API_PUBLIC_ORIGIN must be a valid HTTPS origin.")
    return raw


def configured_mcp_resource() -> str | None:
    origin = configured_mcp_origin()
    return f"{origin}/mcp" if origin else None


def mcp_authentication_challenge() -> bytes:
    origin = configured_mcp_origin()
    metadata = (
        f' resource_metadata="{origin}/.well-known/oauth-protected-resource/mcp",' if origin else ""
    )
    return f'Bearer{metadata} scope="mcp:tools"'.encode("ascii")
