"""Retire a replaced Google login through the existing shared-grant authority."""

from __future__ import annotations

from typing import Any, Optional

from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services.pod_connector_credential_seal import PROVIDER_GOOGLE


async def retire_replaced(
    log: Any,
    *,
    hushh_id: str,
    previous: Optional[store.ConnectorCredential],
    kept: str,
    post: Any,
) -> None:
    """A replaced login's grant is revoked only when nothing here still uses it."""
    from hushh_mcp.services.pod_connector_connect import _revoke_unless_shared

    if previous is None or previous.provider != PROVIDER_GOOGLE:
        return
    if not previous.refresh_token or previous.refresh_token == kept:
        return
    await _revoke_unless_shared(
        log,
        hushh_id=hushh_id,
        token=previous.refresh_token,
        client_id=previous.client_id,
        subject=previous.account_subject,
        post=post,
    )
