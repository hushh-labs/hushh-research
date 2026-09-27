"""Best-effort provider-side release of an erased account's third-party grants.

Account deletion removes every locally stored OAuth credential inside its erasure
transaction. That makes the grants unusable by Hussh, but the person's provider
account (for example "Third-party access" at Google) would still list them, and
a Gmail mailbox watch would keep publishing until it expires.

This module keeps that release separate from the erasure authority:

1. ``snapshot_provider_credentials_in_transaction`` copies only the encrypted
   credential rows, inside the erasure transaction and before they are deleted.
   It runs under a savepoint and never raises, so it cannot abort erasure.
2. ``release_provider_grants_after_erasure`` runs only after the erasure has
   committed. Each owning service decrypts its own envelope, stops a live Gmail
   watch, and revokes the grant. The whole step is bounded and never raises: a
   provider outage must not turn a completed deletion into a failed one.

Decrypted tokens exist only in local variables of the owning service's call and
are never logged, persisted, or returned.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
from sqlalchemy import text

logger = logging.getLogger(__name__)

GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
DRIVE_CONNECTOR_ID = "google_drive"
PROVIDER_RELEASE_TIMEOUT_SECONDS = 8.0
_REVOKE_HTTP_TIMEOUT_SECONDS = 5.0

# Tables whose rows hold a provider credential for the owner, in snapshot order.
# Each query is static; to_jsonb keeps the read independent of column drift.
_CREDENTIAL_SOURCES = (
    (
        "google_provider_connections",
        "google_connection",
        text(
            "SELECT to_jsonb(source_row) AS row FROM google_provider_connections AS source_row "
            "WHERE source_row.user_id = :user_id"
        ),
    ),
    (
        "kai_gmail_connections",
        "gmail_receipts",
        text(
            "SELECT to_jsonb(source_row) AS row FROM kai_gmail_connections AS source_row "
            "WHERE source_row.user_id = :user_id"
        ),
    ),
    (
        "user_external_connector_connections",
        "external_connector",
        text(
            "SELECT to_jsonb(source_row) AS row FROM user_external_connector_connections "
            "AS source_row WHERE source_row.user_id = :user_id"
        ),
    ),
)


@dataclass(frozen=True)
class ProviderCredentialSnapshot:
    """Encrypted credential rows captured before erasure. Never serialized."""

    user_id: str
    rows: dict[str, tuple[dict[str, Any], ...]] = field(default_factory=dict, repr=False)
    collection_failed: bool = False

    @property
    def is_empty(self) -> bool:
        return not any(self.rows.values())


def snapshot_provider_credentials_in_transaction(
    conn,
    *,
    user_id: str,
    table_exists: Callable[[str], bool],
) -> ProviderCredentialSnapshot:
    """Copy the owner's encrypted provider rows without risking the erasure."""
    rows: dict[str, tuple[dict[str, Any], ...]] = {}
    try:
        with conn.begin_nested():
            for table_name, source, query in _CREDENTIAL_SOURCES:
                if not table_exists(table_name):
                    continue
                result = conn.execute(query, {"user_id": user_id})
                rows[source] = tuple(
                    dict(record["row"])
                    for record in result.mappings()
                    if isinstance(record.get("row"), dict)
                )
    except Exception as exc:
        logger.warning("account_deletion.provider_snapshot_failed error=%s", type(exc).__name__)
        return ProviderCredentialSnapshot(user_id=user_id, collection_failed=True)
    return ProviderCredentialSnapshot(user_id=user_id, rows=rows)


async def revoke_google_oauth_token(token: str) -> str:
    """Revoke one Google grant. An already-invalid token has nothing left to revoke."""
    try:
        async with httpx.AsyncClient(
            timeout=_REVOKE_HTTP_TIMEOUT_SECONDS, follow_redirects=False
        ) as client:
            response = await client.post(GOOGLE_OAUTH_REVOKE_URL, data={"token": token})
    except httpx.HTTPError as exc:
        logger.warning("account_deletion.provider_revoke_failed error=%s", type(exc).__name__)
        return "failed"
    if response.status_code == 200:
        return "revoked"
    if response.status_code == 400:
        return "already_invalid"
    logger.warning("account_deletion.provider_revoke_failed status=%s", response.status_code)
    return "failed"


async def _release_google_connections(snapshot: ProviderCredentialSnapshot) -> list[str]:
    from hushh_mcp.services.google_connection_service import get_google_connection_service

    service = get_google_connection_service()
    outcomes: list[str] = []
    for row in snapshot.rows.get("google_connection", ()):
        token = service.refresh_token_for_erasure(row, user_id=snapshot.user_id)
        outcomes.append(await revoke_google_oauth_token(token) if token else "none")
    return outcomes


async def _release_gmail_receipts(snapshot: ProviderCredentialSnapshot) -> list[dict[str, str]]:
    from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

    service = get_gmail_receipts_service()
    return [
        await service.stop_watch_and_revoke_for_erasure(row)
        for row in snapshot.rows.get("gmail_receipts", ())
    ]


async def _release_external_connectors(snapshot: ProviderCredentialSnapshot) -> list[str]:
    from hushh_mcp.services.external_connector_credentials_service import (
        get_external_connector_credentials_service,
    )

    outcomes: list[str] = []
    for row in snapshot.rows.get("external_connector", ()):
        connector_id = str(row.get("connector_id") or "")
        if not row.get("credential_ciphertext"):
            outcomes.append("none")
            continue
        # Only the verified Google Drive envelope has a provider revocation
        # endpoint and a proven OAuth client binding. A legacy envelope's grant
        # may belong to another client (it could include Mail), and API-key
        # connectors hold a person-supplied key with nothing to revoke.
        if connector_id != DRIVE_CONNECTOR_ID or int(row.get("envelope_version") or 1) != 2:
            outcomes.append("not_applicable")
            continue
        try:
            credential = get_external_connector_credentials_service().open_credential(
                user_id=snapshot.user_id, connector_id=connector_id, row=row
            )
        except Exception as exc:
            logger.warning(
                "account_deletion.connector_credential_unreadable error=%s", type(exc).__name__
            )
            outcomes.append("failed")
            continue
        token = credential.get("refreshToken") or credential.get("accessToken")
        outcomes.append(await revoke_google_oauth_token(str(token)) if token else "none")
    return outcomes


async def _guarded(label: str, release: Callable[[], Any]) -> Any:
    try:
        return await release()
    except Exception as exc:
        logger.warning(
            "account_deletion.provider_release_failed provider=%s error=%s",
            label,
            type(exc).__name__,
        )
        return "failed"


async def release_provider_grants_after_erasure(
    snapshot: ProviderCredentialSnapshot,
    *,
    timeout_seconds: float = PROVIDER_RELEASE_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Stop watches and revoke grants for a committed erasure. Never raises."""
    if snapshot.collection_failed:
        return {"status": "snapshot_failed"}
    if snapshot.is_empty:
        return {"status": "no_provider_grants"}

    releases = {
        "google_connection": lambda: _release_google_connections(snapshot),
        "gmail_receipts": lambda: _release_gmail_receipts(snapshot),
        "external_connectors": lambda: _release_external_connectors(snapshot),
    }
    try:
        outcomes = await asyncio.wait_for(
            asyncio.gather(*(_guarded(label, run) for label, run in releases.items())),
            timeout=timeout_seconds,
        )
    except TimeoutError:
        logger.warning("account_deletion.provider_release_deadline_exceeded")
        return {"status": "timed_out"}
    return {"status": "attempted", **dict(zip(releases, outcomes, strict=True))}
