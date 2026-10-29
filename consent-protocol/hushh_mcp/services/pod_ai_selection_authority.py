"""Validate an AI configuration write against its sealed-log snapshot."""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any

from hushh_mcp.services.pod_authority_store import PodAuthorityStore
from hushh_mcp.services.pod_binding_contract import ROLE_APP, PodSessionRefused


def require_snapshot_authority(
    records: Any, *, log: Any, owner: str, session: Mapping[str, Any], scope: str
) -> None:
    """Refuse if this exact log head no longer authorizes the captured session.

    The caller must append against the sequence of these records and repeat this
    check after every conflict. The in-memory trust index may lag a durable revoke.
    """
    projection = PodAuthorityStore(log, hushh_id=owner)
    projection.apply_records(records)
    subject = session.get("subject_id")
    status = projection.subject(subject if isinstance(subject, str) else "")
    trust = status.trust
    binding = trust.binding if trust is not None else {}
    version, expiry = session.get("version"), session.get("exp")
    binding_expiry = binding.get("expires_at_ms")
    session_scopes, binding_scopes = session.get("scopes"), binding.get("scopes")
    valid = (
        status.state == "trusted"
        and trust is not None
        and type(version) is int
        and version == trust.version
        and session.get("hushh_id") == owner == binding.get("hushh_id")
        and subject == binding.get("subject_id")
        and session.get("user_id") == binding.get("user_id")
        and bool(session.get("user_id"))
        and session.get("role") == trust.role == binding.get("role") == ROLE_APP
        and isinstance(session_scopes, list)
        and isinstance(binding_scopes, list)
        and scope in session_scopes
        and scope in binding_scopes
        and type(expiry) is int
        and type(binding_expiry) is int
        and expiry > int(time.time())
        and binding_expiry > int(time.time() * 1000)
    )
    if not valid:
        raise PodSessionRefused("revoked", "owner session is not current at the log head")
