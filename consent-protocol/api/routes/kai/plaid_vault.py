"""Zero-knowledge Plaid passthrough for the owner's device.

Founder decision 2026-09-23: a person's Plaid access token is sealed in THEIR
vault (end-to-end, BYOK). Hussh holds only its own Plaid client secret, so this
router makes Plaid HTTP calls on behalf of the device and forgets everything
the moment the response is sent.

Guarantees this module must keep (see
``docs/architecture/finance/plaid-vault-passthrough.md``):

- NO database reads or writes and NO item/token persistence. There is no
  server registry of connections for this flow, and no webhook: refresh
  happens when the person unlocks the app and the device calls ``/snapshot``.
- NO logging of request or response bodies, tokens, cursors, or financial
  fields. Failure logs carry only the route name, Plaid ``error_code`` /
  ``error_type`` and HTTP status. The app's observability middleware logs
  route template, status and latency only (never bodies).
- Every response, including errors and validation failures, carries
  ``Cache-Control: no-store``. Validation errors are re-rendered without the
  offending ``input`` value so a malformed token is never echoed back.
- Every endpoint requires the VAULT_OWNER consent token
  (``require_vault_owner_token``), the same dependency the consent-gated Kai
  routes use.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
from functools import lru_cache
from time import perf_counter
from typing import Any, Callable, Coroutine, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from api.middlewares.observability import get_request_trace_metadata
from hushh_mcp.integrations.plaid import PlaidApiError, PlaidHttpClient, PlaidRuntimeConfig
from hushh_mcp.integrations.plaid.products import apply_new_vault_link_products
from hushh_mcp.integrations.plaid.vault_snapshot import (
    TRANSACTIONS_SYNC_MAX_PAGES as TRANSACTIONS_SYNC_MAX_PAGES,
)
from hushh_mcp.integrations.plaid.vault_snapshot import (
    clean_string,
    item_products,
    log_plaid_failure,
    read_vault_snapshot,
    string_list,
)
from hushh_mcp.services.owner_placement_guard import hub_content_owner

logger = logging.getLogger(__name__)

_NO_STORE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}

_ITEM_ALREADY_REMOVED_CODES = frozenset({"ITEM_NOT_FOUND"})
_LOCAL_SANDBOX_PROOF_DEPLOYMENTS = frozenset({"local", "test"})

# Plaid tokens and cursors are opaque ASCII; bound and constrain them so a
# request can never smuggle arbitrary text through to Plaid.
_OPAQUE_ID_PATTERN = r"^[A-Za-z0-9._\-]+$"
_CURSOR_PATTERN = r"^[A-Za-z0-9._\-+/=]+$"

_CLIENT_USER_ID_CONTEXT = b"hussh.kai.plaid.vault.client_user_id.v1"


class _NoStoreRoute(APIRoute):
    """Route class that marks every response ``no-store`` and scrubs 422s.

    FastAPI's default validation error body includes the rejected ``input``,
    which for this router would be a Plaid token. Errors raised by the auth
    dependency and by the handler are rendered here too, so they carry the
    same headers.
    """

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original_handler = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                response = await original_handler(request)
            except RequestValidationError as exc:
                response = JSONResponse(
                    status_code=422,
                    content={
                        "detail": [
                            {
                                "loc": list(error.get("loc", ())),
                                "type": error.get("type"),
                                "msg": error.get("msg"),
                            }
                            for error in exc.errors()
                        ]
                    },
                )
            except HTTPException as exc:
                response = JSONResponse(
                    status_code=exc.status_code,
                    content={"detail": exc.detail},
                    headers=dict(exc.headers or {}),
                )
            for key, value in _NO_STORE_HEADERS.items():
                response.headers[key] = value
            return response

        return handler


router = APIRouter(prefix="/plaid/vault", tags=["Kai Plaid Vault"], route_class=_NoStoreRoute)


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class VaultLinkTokenRequest(_StrictModel):
    platform: Literal["web", "ios", "android"] = "web"
    redirect_uri: str | None = Field(default=None, max_length=2048)
    # A non-secret marker used only by the local Plaid Sandbox proof.  It is
    # deliberately opt-in so ordinary clients retain their existing contract.
    sandbox_proof: bool = False
    origin_surface: Literal["profile_nws", "agentone_chat"] | None = None
    additional_product: Literal["investments", "liabilities"] | None = None
    select_accounts: bool = False
    # Update mode (relink after "login required"): the device passes the token
    # it holds sealed; Plaid returns a Link token bound to that Item.  Used for
    # this one call only, never stored or logged.
    access_token: str | None = Field(
        default=None, min_length=8, max_length=256, pattern=_OPAQUE_ID_PATTERN
    )


class VaultExchangeRequest(_StrictModel):
    public_token: str = Field(..., min_length=8, max_length=256, pattern=_OPAQUE_ID_PATTERN)


class VaultSnapshotRequest(_StrictModel):
    access_token: str = Field(..., min_length=8, max_length=256, pattern=_OPAQUE_ID_PATTERN)
    transactions_cursor: str | None = Field(default=None, max_length=4096, pattern=_CURSOR_PATTERN)
    transactions_continuation: bool = False


class VaultRemoveRequest(_StrictModel):
    access_token: str = Field(..., min_length=8, max_length=256, pattern=_OPAQUE_ID_PATTERN)


@lru_cache(maxsize=1)
def _runtime_config() -> PlaidRuntimeConfig:
    return PlaidRuntimeConfig.from_env()


def _plaid_config() -> PlaidRuntimeConfig:
    return _runtime_config()


def _plaid_client() -> PlaidHttpClient:
    return PlaidHttpClient(_plaid_config())


def _signing_key() -> bytes:
    from hushh_mcp.config import APP_SIGNING_KEY

    return str(APP_SIGNING_KEY or "").encode("utf-8")


def _client_user_id(user_id: str) -> str:
    """Opaque, stable Plaid ``client_user_id`` for one owner.

    Plaid needs a stable per-person identifier; it never sees the Hussh user
    id or an email, only this HMAC under the server signing key.
    """
    key = _signing_key()
    if not key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "PLAID_VAULT_UNCONFIGURED", "message": "Plaid is not available."},
        )
    digest = hmac.new(key, _CLIENT_USER_ID_CONTEXT + b":" + user_id.encode("utf-8"), hashlib.sha256)
    return f"hv1_{digest.hexdigest()}"


_SAFE_MESSAGES = {
    "INVALID_INPUT": "Plaid rejected the request. Reconnect the account and try again.",
    "INVALID_REQUEST": "Plaid rejected the request.",
    "ITEM_ERROR": "The linked connection needs attention.",
    "RATE_LIMIT_EXCEEDED": "Plaid is rate limiting requests. Try again shortly.",
    "NETWORK_ERROR": "Could not reach Plaid right now. Try again shortly.",
    "API_ERROR": "Plaid had a problem. Try again shortly.",
    "INSTITUTION_ERROR": "The institution is not responding right now.",
}


def _to_http_exception(route: str, error: Exception) -> HTTPException:
    """Map a failure to a safe error: codes only, never Plaid's payload."""
    if isinstance(error, HTTPException):
        return error
    if isinstance(error, PlaidApiError):
        error_type = error.error_type or "API_ERROR"
        code = error.error_code or "PLAID_API_ERROR"
        if error_type == "RATE_LIMIT_EXCEEDED":
            http_status = status.HTTP_429_TOO_MANY_REQUESTS
        elif error_type in {"INVALID_INPUT", "INVALID_REQUEST", "ITEM_ERROR"}:
            http_status = status.HTTP_400_BAD_REQUEST
        elif error.status_code == 504:
            http_status = status.HTTP_504_GATEWAY_TIMEOUT
        else:
            http_status = status.HTTP_502_BAD_GATEWAY
        log_plaid_failure(route, error, http_status)
        return HTTPException(
            status_code=http_status,
            detail={
                "code": code,
                "error_type": error_type,
                "message": _SAFE_MESSAGES.get(error_type, _SAFE_MESSAGES["API_ERROR"]),
            },
        )
    logger.error("kai.plaid_vault.%s_failed error=%s", route, type(error).__name__)
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail={"code": "PLAID_VAULT_FAILURE", "message": _SAFE_MESSAGES["API_ERROR"]},
    )


def _require_configured() -> PlaidRuntimeConfig:
    config = _plaid_config()
    if not config.configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "PLAID_VAULT_UNCONFIGURED", "message": "Plaid is not available."},
        )
    return config


def _local_sandbox_proof_deployment() -> bool:
    """A sandbox provider is not enough: hosted UAT must never run this proof."""
    if os.getenv("K_SERVICE") or os.getenv("K_REVISION"):
        return False
    if os.getenv("HUSHH_LOCAL_PLAID_SANDBOX_PROOF") != "true":
        return False
    deployment_identities = {
        name: str(value).strip().lower()
        for name in ("ENVIRONMENT", "HUSHH_DEPLOY_ENV", "APP_RUNTIME_PROFILE")
        if (value := os.getenv(name)) and str(value).strip()
    }
    # A missing identity, contradictory deployment metadata, or ambiguous
    # development profile must never turn a provider-sandbox configuration
    # into a hosted proof endpoint.
    return bool(deployment_identities) and (
        len(set(deployment_identities.values())) == 1
        and next(iter(deployment_identities.values())) in _LOCAL_SANDBOX_PROOF_DEPLOYMENTS
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _trace_link_token(payload: VaultLinkTokenRequest, response: dict, started: float) -> None:
    if payload.origin_surface:
        trace = get_request_trace_metadata()
        logger.info(
            "plaid.link_token origin_surface=%s update=%s outcome=%s elapsed_ms=%d request_id=%s trace_id=%s",
            payload.origin_surface,
            bool(payload.access_token),
            "ready" if clean_string(response.get("link_token")) else "incomplete",
            round((perf_counter() - started) * 1000),
            trace.request_id if trace else None,
            trace.trace_id if trace else None,
        )


@router.post("/link-token")
async def create_vault_link_token(
    payload: VaultLinkTokenRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """Create a Link token for the existing owner connection flow."""
    started = perf_counter()
    try:
        config = _require_configured()
        # Never trust a caller to select its Plaid environment.  The local
        # proof marker is valid only when this server's resolved runtime
        # configuration is Sandbox, and is rejected before Plaid is called.
        if payload.sandbox_proof and (
            config.environment != "sandbox" or not _local_sandbox_proof_deployment()
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "PLAID_SANDBOX_PROOF_FORBIDDEN",
                    "message": "This verification flow is not available.",
                },
            )
        link_payload: dict[str, Any] = {
            "client_name": config.client_name,
            "user": {"client_user_id": _client_user_id(str(token_data["user_id"]))},
            "country_codes": list(config.country_codes),
            "language": config.language,
        }
        if config.manual_entry_enabled:
            link_payload["investments"] = {"allow_manual_entry": True}
        try:
            config.apply_link_platform(
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
                history_days=config.tx_history_days,
                liabilities_enabled=liabilities_enabled,
            )
        # Deliberately no "webhook": refresh is device-driven on unlock.
        link_payload.pop("webhook", None)

        response = await _plaid_client().post("/link/token/create", link_payload)
        _trace_link_token(payload, response, started)
    except Exception as exc:
        raise _to_http_exception("link_token", exc) from exc
    return {
        "link_token": clean_string(response.get("link_token")),
        "expiration": clean_string(response.get("expiration")),
    }


@router.post("/exchange")
async def exchange_vault_public_token(
    payload: VaultExchangeRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """Exchange a public token and return the access token to the device.

    The access token is returned, never stored. Once the exchange succeeds,
    enrichment failures (item or institution lookup) degrade to partial data
    instead of an error, so the device never loses a freshly minted token.
    """
    del token_data  # Auth gate only; no per-user state exists for this flow.
    try:
        config = _require_configured()
        client = _plaid_client()
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
        item = item_response.get("item") if isinstance(item_response.get("item"), dict) else {}
        products = item_products(item)
        consented_products = string_list(item.get("consented_products"))
        institution_id = clean_string(item.get("institution_id"))
        if institution_id:
            institution = {"id": institution_id, "name": clean_string(item.get("institution_name"))}
            if institution["name"] is None:
                try:
                    institution_response = await client.post(
                        "/institutions/get_by_id",
                        {
                            "institution_id": institution_id,
                            "country_codes": list(config.country_codes),
                        },
                    )
                    record = institution_response.get("institution")
                    if isinstance(record, dict):
                        institution["name"] = clean_string(record.get("name"))
                except PlaidApiError as exc:
                    log_plaid_failure("exchange_institution", exc)
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
async def vault_snapshot(
    payload: VaultSnapshotRequest,
    token_data: dict = Depends(hub_content_owner),
) -> dict[str, Any]:
    """Fetch a fresh snapshot for one connection, statelessly.

    A connection that needs re-authentication (e.g. ``ITEM_LOGIN_REQUIRED``) or whose
    sealed token Plaid no longer accepts (``INVALID_ACCESS_TOKEN``) returns HTTP 200 with
    ``item.error`` set, so the device records the state instead of re-reading every unlock.
    """
    del token_data  # Auth gate only; no per-user state exists for this flow.
    access_token = payload.access_token
    try:
        _require_configured()
        return await read_vault_snapshot(
            _plaid_client(),
            access_token,
            payload.transactions_cursor,
            continuation=payload.transactions_continuation,
        )
    except Exception as exc:
        raise _to_http_exception("snapshot", exc) from exc


@router.post("/remove")
async def remove_vault_item(
    payload: VaultRemoveRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """Revoke the Item at Plaid. Idempotent: an already removed Item is fine."""
    del token_data  # Auth gate only; no per-user state exists for this flow.
    try:
        _require_configured()
        await _plaid_client().post("/item/remove", {"access_token": payload.access_token})
    except PlaidApiError as exc:
        if (exc.error_code or "") in _ITEM_ALREADY_REMOVED_CODES:
            return {"removed": True}
        raise _to_http_exception("remove", exc) from exc
    except Exception as exc:
        raise _to_http_exception("remove", exc) from exc
    return {"removed": True}
