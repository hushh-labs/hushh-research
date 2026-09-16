"""
mcp_modules/tools/pkm_convenience_tools.py

Convenience wrapper for the owner's own narrow PKM attribute read.

The full lifecycle (request_consent -> check_consent_status ->
get_encrypted_scoped_export) already exists in public_tools_v3.py and is
already granted to every developer app via core_consent. This tool does not
add new capability -- it collapses that 3-call round trip into one for the
common case: the caller wants exactly one narrow attr.<domain>.<leaf>.*
attribute for a user who has already agreed to grant it (or is expected to
approve promptly).

It never accepts a domain-wildcard or pkm.read scope -- only the same
attr.<domain>.<leaf>.* shape hushh_mcp/constants.py already enforces as the
only externally-requestable PKM scope. And it does nothing to the
ciphertext-only guarantee over the remote/hosted transport:
handle_get_encrypted_scoped_export already branches on
is_local_stdio_transport() internally, so a remote caller still only ever
receives ciphertext.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

from mcp.types import TextContent

from .public_tools_v3 import (
    handle_check_consent_status,
    handle_get_encrypted_scoped_export,
    handle_request_consent,
)

# Mirrors hushh_mcp/constants.py's _SCOPE_SLUG exactly -- the only
# externally-requestable PKM scope shape is attr.<domain>.<leaf>.*, never a
# domain wildcard or pkm.read.
_SLUG_RE = re.compile(r"^[a-z](?:[a-z0-9_]{0,62}[a-z0-9])?$")

# Stay comfortably under the documented 55-second partner-host settlement
# budget referenced by BACKEND_REQUEST_TIMEOUT in public_tools_v3.py.
_MAX_WAIT_SECONDS_CAP = 45
_DEFAULT_POLL_AFTER_SECONDS = 5


def _invalid_scope_component(component: str) -> list[TextContent]:
    payload = {
        "status": "error",
        "error_code": "INVALID_SCOPE_COMPONENT",
        "error": f"{component} must be a lowercase slug (letters, digits, underscore).",
    }
    return [TextContent(type="text", text=json.dumps(payload))]


async def handle_read_own_pkm_attribute(args: dict[str, Any]) -> list[TextContent]:
    domain = str(args.get("domain") or "").strip().lower()
    leaf = str(args.get("leaf") or "").strip().lower()
    if not _SLUG_RE.fullmatch(domain):
        return _invalid_scope_component("domain")
    if not _SLUG_RE.fullmatch(leaf):
        return _invalid_scope_component("leaf")

    expected_scope = f"attr.{domain}.{leaf}.*"

    content, request_payload = await handle_request_consent(
        {
            "user_identifier": args.get("user_identifier"),
            "scope": expected_scope,
            "purpose": args.get("purpose") or "read_own_pkm_attribute convenience tool",
        }
    )
    if "error_code" in request_payload:
        return content

    if request_payload.get("status") == "granted":
        grant_ref = request_payload["grant_ref"]
    else:
        request_ref = request_payload["request_ref"]
        max_wait_seconds = min(int(args.get("max_wait_seconds") or 20), _MAX_WAIT_SECONDS_CAP)
        deadline = time.monotonic() + max_wait_seconds
        poll_after = request_payload.get("poll_after_seconds") or _DEFAULT_POLL_AFTER_SECONDS
        grant_ref = None
        while time.monotonic() < deadline:
            await asyncio.sleep(poll_after)
            content, status_payload = await handle_check_consent_status(
                {"request_ref": request_ref}
            )
            if "error_code" in status_payload:
                return content
            status = status_payload["status"]
            if status == "granted":
                grant_ref = status_payload["grant_ref"]
                break
            if status in {"denied", "expired", "revoked", "cancelled"}:
                return [
                    TextContent(
                        type="text",
                        text=json.dumps({"status": status, "request_ref": request_ref}),
                    )
                ]
            poll_after = status_payload.get("poll_after_seconds") or poll_after
        if grant_ref is None:
            return [
                TextContent(
                    type="text",
                    text=json.dumps(
                        {
                            "status": "pending",
                            "request_ref": request_ref,
                            "message": (
                                "Still awaiting approval; call check_consent_status/"
                                "get_encrypted_scoped_export directly to continue."
                            ),
                        }
                    ),
                )
            ]

    content, _export_payload = await handle_get_encrypted_scoped_export(
        {"grant_ref": grant_ref, "expected_scope": expected_scope}
    )
    return content
