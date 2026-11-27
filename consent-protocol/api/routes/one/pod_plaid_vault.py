# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Sovereign pod Plaid vault passthrough mediated by out-of-sandbox Sentinel.

The owner's pod holds zero Plaid client secrets and zero database credentials.
Admission runs on the pod's owner-local door (`owner_local_door`), and outbound
Plaid HTTP requests pass over the cluster-internal Sentinel gateway (`:8082`)
using the pod's IP-bound lease surrogate (`HUSSH_MODEL_GATEWAY_TOKEN`).

Neither the pod nor Sentinel stores Plaid tokens, cursors, or financial fields;
encrypted financial state commits directly to the owner's Zero-Knowledge Central
Encrypted PKM Mirror.
"""

from __future__ import annotations

import logging
import os
from time import perf_counter
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, status

from api.routes.kai.plaid_vault import (
    _ITEM_ALREADY_REMOVED_CODES,
    VaultExchangeRequest,
    VaultLinkTokenRequest,
    VaultRemoveRequest,
    VaultSnapshotRequest,
    _NoStoreRoute,
    _to_http_exception,
)
from api.routes.one.pod_owner_door import admit_owner_local, owner_local_door
from hushh_mcp.integrations.plaid import PlaidApiError, PlaidRuntimeConfig
from hushh_mcp.integrations.plaid.products import apply_new_vault_link_products
from hushh_mcp.integrations.plaid.vault_snapshot import (
    clean_string,
    item_products,
    log_plaid_failure,
    read_vault_snapshot,
    string_list,
)
from hushh_mcp.services.pod_session_authority import SCOPE_PKM_READ

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/one/pod/plaid/vault",
    tags=["personal-agent"],
    route_class=_NoStoreRoute,
)


def _sentinel_gateway_auth() -> tuple[str, str]:
    gateway_url = (
        (os.getenv("HUSSH_MODEL_GATEWAY_URL") or os.getenv("SENTINEL_MODEL_GATEWAY_URL") or "")
        .strip()
        .rstrip("/")
    )
    token = (os.getenv("HUSSH_MODEL_GATEWAY_TOKEN") or "").strip()
    if not gateway_url or not token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "PLAID_VAULT_UNCONFIGURED", "message": "Plaid is not available."},
        )
    return gateway_url, token


class SentinelPlaidClient:
    """Forwards stateless Plaid calls from the sovereign pod to Sentinel `:8082`."""

    def __init__(self, gateway_url: str, surrogate_token: str) -> None:
        self._gateway_url = gateway_url
        self._surrogate_token = surrogate_token

    async def ready_environment(self) -> str:
        async with httpx.AsyncClient(timeout=10.0, trust_env=False, follow_redirects=False) as http:
            resp = await http.get(
                f"{self._gateway_url}/v1/plaid/ready",
                headers={"Authorization": f"Bearer {self._surrogate_token}"},
            )
        if resp.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"code": "PLAID_VAULT_UNCONFIGURED", "message": "Plaid is not available."},
            )
        body = resp.json()
        return str(body.get("environment") or "sandbox")

    async def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0, trust_env=False, follow_redirects=False) as http:
            resp = await http.post(
                f"{self._gateway_url}/v1/plaid/proxy",
                json={"path": path, "payload": payload},
                headers={
                    "Authorization": f"Bearer {self._surrogate_token}",
                    "Content-Type": "application/json",
                },
            )
        try:
            body = resp.json()
        except ValueError as exc:
            raise RuntimeError("Invalid Plaid gateway response") from exc
        if not isinstance(body, dict):
            raise RuntimeError("Invalid Plaid gateway response")
        if resp.status_code == 503 and body.get("code") == "PLAID_VAULT_UNCONFIGURED":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"code": "PLAID_VAULT_UNCONFIGURED", "message": "Plaid is not available."},
            )
        if resp.status_code >= 400:
            raise PlaidApiError(
                message=str(body.get("error_message") or body.get("detail") or "Plaid error"),
                status_code=resp.status_code,
                error_code=clean_string(body.get("error_code")) or "PLAID_API_ERROR",
                error_type=clean_string(body.get("error_type")) or "API_ERROR",
                display_message=clean_string(body.get("display_message")),
                payload=body,
            )
        return body


async def _admit_pod_plaid(request: Request) -> tuple[SentinelPlaidClient, str]:
    door = await owner_local_door(
        request.headers.get("x-consent-token"),
        request.headers.get("authorization"),
        scope=SCOPE_PKM_READ,
        held=False,
    )
    await admit_owner_local(
        str(door.get("consent_token") or ""),
        verifier=door.get("verifier"),
        session=door.get("session"),
        scope=SCOPE_PKM_READ,
    )
    gateway_url, surrogate = _sentinel_gateway_auth()
    client = SentinelPlaidClient(gateway_url, surrogate)
    env_name = await client.ready_environment()
    return client, env_name


@router.post("/link-token")
async def pod_create_vault_link_token(
    payload: VaultLinkTokenRequest, request: Request
) -> dict[str, Any]:
    started = perf_counter()
    client, _env_name = await _admit_pod_plaid(request)
    try:
        if payload.sandbox_proof:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "PLAID_SANDBOX_PROOF_FORBIDDEN",
                    "message": "This verification flow is not available.",
                },
            )
        cfg = PlaidRuntimeConfig.from_env()
        link_payload: dict[str, Any] = {
            "client_name": cfg.client_name,
            "user": {"client_user_id": "sentinel_bound"},
            "country_codes": list(cfg.country_codes),
            "language": cfg.language,
        }
        if cfg.manual_entry_enabled:
            link_payload["investments"] = {"allow_manual_entry": True}
        try:
            cfg.apply_link_platform(
                link_payload,
                platform=payload.platform,
                requested_redirect_uri=payload.redirect_uri,
            )
        except RuntimeError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "PLAID_REDIRECT_URI_INVALID",
                    "message": "The redirect URI is not allowed.",
                },
            ) from exc
        liabilities_enabled = os.getenv("PLAID_NWS_LIABILITIES_ENABLED") == "true"
        if payload.additional_product == "liabilities" and not liabilities_enabled:
            raise HTTPException(status_code=403, detail="Debt details are unavailable.")
        if payload.access_token:
            link_payload["access_token"] = payload.access_token
            if payload.additional_product:
                link_payload["additional_consented_products"] = [payload.additional_product]
            if payload.select_accounts:
                link_payload["update"] = {"account_selection_enabled": True}
        else:
            if payload.additional_product or payload.select_accounts:
                raise HTTPException(status_code=400, detail="An existing connection is required.")
            apply_new_vault_link_products(
                link_payload,
                score_link=payload.origin_surface is not None,
                history_days=cfg.tx_history_days,
                liabilities_enabled=liabilities_enabled,
            )
        link_payload.pop("webhook", None)
        response = await client.post("/link/token/create", link_payload)
        logger.info(
            "pod.plaid.link_token outcome=%s elapsed_ms=%d",
            "ready" if clean_string(response.get("link_token")) else "incomplete",
            round((perf_counter() - started) * 1000),
        )
    except Exception as exc:
        raise _to_http_exception("link_token", exc) from exc
    return {
        "link_token": clean_string(response.get("link_token")),
        "expiration": clean_string(response.get("expiration")),
    }


@router.post("/exchange")
async def pod_exchange_vault_public_token(
    payload: VaultExchangeRequest, request: Request
) -> dict[str, Any]:
    client, _env_name = await _admit_pod_plaid(request)
    try:
        exchange = await client.post(
            "/item/public_token/exchange", {"public_token": payload.public_token}
        )
    except Exception as exc:
        raise _to_http_exception("exchange", exc) from exc

    access_token = clean_string(exchange.get("access_token"))
    item_id = clean_string(exchange.get("item_id"))
    if not access_token or not item_id:
        raise _to_http_exception("exchange", RuntimeError("incomplete exchange response"))

    products: list[str] = []
    consented_products: list[str] = []
    institution: dict[str, str | None] | None = None
    try:
        item_response = await client.post("/item/get", {"access_token": access_token})
        raw_item = item_response.get("item")
        item: dict[str, Any] = raw_item if isinstance(raw_item, dict) else {}
        products = item_products(item)
        consented_products = string_list(item.get("consented_products"))
        institution_id = clean_string(item.get("institution_id"))
        if institution_id:
            inst_obj: dict[str, str | None] = {
                "id": institution_id,
                "name": clean_string(item.get("institution_name")),
            }
            if inst_obj["name"] is None:
                try:
                    institution_response = await client.post(
                        "/institutions/get_by_id",
                        {"institution_id": institution_id, "country_codes": ["US"]},
                    )
                    record = institution_response.get("institution")
                    if isinstance(record, dict):
                        inst_obj["name"] = clean_string(record.get("name"))
                except PlaidApiError as exc:
                    log_plaid_failure("exchange_institution", exc)
            institution = inst_obj
    except PlaidApiError as exc:
        log_plaid_failure("exchange_item", exc)

    return {
        "access_token": access_token,
        "item_id": item_id,
        "institution": institution,
        "products": products,
        "consented_products": consented_products,
    }


@router.post("/snapshot")
async def pod_vault_snapshot(payload: VaultSnapshotRequest, request: Request) -> dict[str, Any]:
    client, env_name = await _admit_pod_plaid(request)
    try:
        return await read_vault_snapshot(
            client,  # type: ignore[arg-type]
            payload.access_token,
            payload.transactions_cursor,
            continuation=payload.transactions_continuation,
            include_country_on_file=payload.include_country_on_file,
            allow_sandbox_identity_without_consent=env_name == "sandbox",
        )
    except Exception as exc:
        raise _to_http_exception("snapshot", exc) from exc


@router.post("/remove")
async def pod_remove_vault_item(payload: VaultRemoveRequest, request: Request) -> dict[str, Any]:
    client, _env_name = await _admit_pod_plaid(request)
    try:
        await client.post("/item/remove", {"access_token": payload.access_token})
    except PlaidApiError as exc:
        if (exc.error_code or "") in _ITEM_ALREADY_REMOVED_CODES:
            return {"removed": True}
        raise _to_http_exception("remove", exc) from exc
    except Exception as exc:
        raise _to_http_exception("remove", exc) from exc
    return {"removed": True}
