"""Commercial metadata adapter for existing developer consent surfaces.

The canonical commercial service owns tariffs, quotes and paid admission. This
module reads its authenticated state and preserves the existing consent response
contract. Recipient registration remains owned by DeveloperRegistryService.
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlencode

from asyncpg.exceptions import UndefinedTableError
from fastapi import HTTPException

from hushh_mcp.consent.export_envelope import (
    connector_key_fingerprint,
    scope_handle_for_machine_scope,
)
from hushh_mcp.services.consent_request_links import frontend_origin
from hushh_mcp.services.developer_registry_service import (
    DeveloperPrincipal,
    DeveloperRegistryService,
)


def offline_free_context() -> bool:
    offline = (
        str(os.getenv("DB_OFFLINE") or "").strip().lower() in {"1", "true", "yes", "on"}
        and str(os.getenv("SCOPE_COMMERCE_ENABLED") or "").strip().lower() != "true"
    )
    if not offline:
        return False
    from db.offline_db import _get_db_path

    path = Path(_get_db_path()).resolve()
    if not path.exists():
        # A fresh offline database has no persisted paid authority. Do not
        # create it merely to classify the legacy free compatibility path.
        return True
    try:
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as connection:
            if connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name LIKE 'scope_commerce_%' LIMIT 1"
            ).fetchone():
                return False
            audit = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='consent_audit'"
            ).fetchone()
            if (
                audit
                and connection.execute(
                    """SELECT 1 FROM consent_audit WHERE metadata LIKE '%commercial_required%'
                OR metadata LIKE '%commerce_quote_id%' OR metadata LIKE '%commerce_purchase_id%' LIMIT 1"""
                ).fetchone()
            ):
                return False
        return True
    except sqlite3.Error:
        # Unknown storage cannot be represented as an authoritative free price.
        return False


class CommerceReader(Protocol):
    async def get_tariff(
        self, *, owner_user_id: str, scope_handle: str, machine_scope: str
    ) -> dict[str, Any] | None: ...

    async def list_tariffs(self, *, owner_user_id: str) -> list[dict[str, Any]]: ...

    async def request_status(
        self, *, request_id: str, buyer_app_id: str
    ) -> dict[str, Any] | None: ...


def commerce_service() -> CommerceReader:
    from hushh_mcp.services.scope_commerce import ScopeCommerceService

    service: CommerceReader = ScopeCommerceService()
    return service


def commerce_unavailable() -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "error_code": "SCOPE_COMMERCE_UNAVAILABLE",
            "message": "Paid access is temporarily unavailable.",
        },
    )


async def scope_tariff(
    owner_user_id: str, scope_handle: str, machine_scope: str, *, reader: CommerceReader
) -> dict[str, Any] | None:
    if offline_free_context():
        return None
    try:
        return await reader.get_tariff(
            owner_user_id=owner_user_id, scope_handle=scope_handle, machine_scope=machine_scope
        )
    except UndefinedTableError:
        if str(os.getenv("SCOPE_COMMERCE_ENABLED") or "").strip().lower() == "true":
            raise commerce_unavailable() from None
        return None
    except Exception:
        raise commerce_unavailable() from None


async def scope_tariffs(owner_user_id: str, *, reader: CommerceReader) -> list[dict[str, Any]]:
    if offline_free_context():
        return []
    try:
        return await reader.list_tariffs(owner_user_id=owner_user_id)
    except UndefinedTableError:
        if str(os.getenv("SCOPE_COMMERCE_ENABLED") or "").strip().lower() == "true":
            raise commerce_unavailable() from None
        return []
    except Exception:
        raise commerce_unavailable() from None


def commerce_epoch(value: object) -> int | None:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


async def request_projection(
    request_id: str,
    *,
    principal: DeveloperPrincipal,
    metadata: dict[str, Any],
    reader: CommerceReader,
) -> dict[str, Any]:
    if not metadata.get("commerce_quote_id"):
        return {}
    try:
        state = await reader.request_status(request_id=request_id, buyer_app_id=principal.app_id)
    except Exception:
        raise commerce_unavailable() from None
    if not state:
        raise commerce_unavailable()
    commercial_state = str(state.get("status") or "quoted")
    active = commercial_state == "active"
    terminal = {"expired", "revoked", "cancelled", "failed"}
    return {
        "quote_ref": str(state.get("quoteId") or metadata["commerce_quote_id"]),
        "price_cents": int(state.get("priceCents") or metadata.get("commerce_price_cents") or 0),
        "currency": "usd",
        "consent_state": "requested" if commercial_state == "quoted" else "approved",
        "payment_state": "consumed"
        if commercial_state in {"armed", "active", "expired", "revoked"}
        else commercial_state,
        "access_state": "active"
        if active
        else "armed"
        if commercial_state == "armed"
        else "ended"
        if commercial_state in terminal
        else "inactive",
        "human_action_url": f"{frontend_origin()}/one/consent?{urlencode({'commerceRequestId': request_id})}",
        "activates_at": commerce_epoch(state.get("activationAt")),
        "expires_at": commerce_epoch(state.get("expiresAt")),
        "status": "granted"
        if active
        else commercial_state
        if commercial_state in {"expired", "revoked", "cancelled"}
        else "pending",
    }


async def require_commerce_payer(
    principal: DeveloperPrincipal, *, connector_key_id: str, recipient_key_fingerprint: str
) -> None:
    app = await asyncio.to_thread(DeveloperRegistryService().get_app, principal.app_id)
    payer_user_id = str((app or {}).get("owner_firebase_uid") or "").strip()
    if not payer_user_id:
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "PAYER_DELEGATION_REQUIRED",
                "message": "A verified app owner must confirm paid access.",
            },
        )
    registered = await asyncio.to_thread(
        DeveloperRegistryService().get_active_connector_key, app_id=principal.app_id
    )
    if not registered or registered.get("connector_wrapping_alg") != "X25519-AES256-GCM":
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "REGISTERED_RECIPIENT_KEY_REQUIRED",
                "message": "Register an app-owned X25519 connector key before requesting priced information.",
            },
        )
    if (
        str(registered["connector_key_id"]) != connector_key_id
        or connector_key_fingerprint(str(registered["connector_public_key"]))
        != recipient_key_fingerprint
    ):
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "CONNECTOR_KEY_REBIND_REQUIRED",
                "message": "The registered recipient key changed. Request access with its current binding.",
            },
        )


def tariff_request_fields(metadata: dict[str, Any]) -> dict[str, Any]:
    if not metadata.get("commercial_required"):
        return {}
    return {
        "tariff_price_cents": int(metadata.get("commerce_tariff_price_cents") or 0),
        "tariff_base_duration_seconds": int(
            metadata.get("commerce_tariff_base_duration_seconds") or 0
        ),
        "tariff_revision": int(metadata.get("commerce_tariff_revision") or 0),
        "paid_required": True,
    }


def merge_status(
    payload: dict[str, Any],
    *,
    fields: dict[str, Any],
    metadata: dict[str, Any],
    terminal_states: set[str],
) -> dict[str, Any]:
    original_status = str(payload.get("status") or "")
    payload.update(tariff_request_fields(metadata))
    if not fields:
        return payload
    payload.update(fields)
    if original_status in {"denied", "expired", "revoked", "cancelled"}:
        payload["status"] = original_status
        payload["access_state"] = "ended"
    elif original_status == "already_granted" and fields["status"] == "granted":
        payload["status"] = "already_granted"
    if payload["status"] not in {"granted", "already_granted"}:
        payload["consent_token"] = None
        payload["grant_ref"] = None
        payload["granted_scope"] = None
    payload["terminal"] = payload["status"] in terminal_states
    return payload


def priced_scope_entries(
    user_id: str, scope_entries: list[dict], tariffs: list[dict[str, Any]]
) -> list[dict]:
    if not tariffs:
        return scope_entries
    by_binding = {
        (str(tariff["machineScope"]), str(tariff["scopeHandle"])): tariff for tariff in tariffs
    }
    priced_entries = []
    for entry in scope_entries:
        scope = str(entry.get("scope") or "")
        handle = entry.get("registry_handle") or scope_handle_for_machine_scope(user_id, scope)
        tariff = by_binding.get((scope, str(handle)))
        if tariff:
            entry = {
                **entry,
                "tariff": {
                    "price_cents": tariff["priceCents"],
                    "base_duration_seconds": tariff["baseDurationSeconds"],
                    "revision": tariff["tariffRevision"],
                    "currency": "usd",
                },
            }
        priced_entries.append(entry)
    return priced_entries


async def intake_metadata(
    tariff: dict[str, Any] | None,
    *,
    principal: DeveloperPrincipal,
    connector_key_id: str,
    recipient_key_fingerprint: str,
) -> dict[str, Any]:
    if not tariff or int(tariff.get("priceCents") or 0) <= 0:
        return {}
    if str(os.getenv("SCOPE_COMMERCE_ENABLED") or "").strip().lower() != "true":
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "SCOPE_COMMERCE_DISABLED",
                "message": "New paid access requests are disabled.",
            },
        )
    await require_commerce_payer(
        principal,
        connector_key_id=connector_key_id,
        recipient_key_fingerprint=recipient_key_fingerprint,
    )
    return {
        "commercial_required": True,
        "commerce_tariff_price_cents": tariff["priceCents"],
        "commerce_tariff_base_duration_seconds": tariff["baseDurationSeconds"],
        "commerce_tariff_revision": tariff["tariffRevision"],
    }
