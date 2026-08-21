"""UAT-only Hushh Tech product-client routes.

The routes deliberately separate the two proofs used by the integration:

* Firebase bearer tokens prove the person and yield the canonical Firebase UID.
* The server-held Hushh Tech developer token proves the calling product.

Launch exchange uses the PKCE verifier as its client proof, matching a normal
public OAuth token endpoint.  Link and compatibility calls require both the
Firebase bearer and the product token.  No owner token, connector private key,
or private-place value crosses this boundary.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import time
from functools import lru_cache
from typing import Any, Literal, Protocol, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token as google_id_token
from pydantic import BaseModel, ConfigDict, Field

from api.developer_auth import authenticate_developer_principal
from api.middlewares.rate_limit import (
    RateLimits,
    consume_shared_rate_limit_budget,
    get_rate_limit_key,
    get_trusted_forwarded_client_ip,
    limiter,
)
from api.utils.firebase_admin import get_firebase_auth_app
from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.developer_registry_service import TOOL_GROUP_HUSHH_TECH_CLIENT
from hushh_mcp.services.hushh_tech_client_service import (
    HushhTechClientError,
    HushhTechClientService,
    hushh_tech_client_enabled,
    require_hushh_tech_client_admission,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/products/hushh-tech", tags=["Hushh Tech UAT client"])

_RECENT_AUTH_MAX_AGE_SECONDS = 5 * 60
_TRUSTED_PROXY_HOPS_ENV = "HUSSH_TECH_TRUSTED_PROXY_HOPS"
_PROXY_AUTHORIZATION_HEADER = "x-hushh-proxy-authorization"
_PROXY_CLIENT_IP_HEADER = "x-hushh-tech-client-ip"


class _StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _LaunchAuthorizationResult(Protocol):
    code: str
    audience: str
    redirect_uri: str


class LaunchAuthorizeRequest(_StrictRequest):
    audience: str = Field(min_length=1, max_length=256)
    redirect_uri: str = Field(min_length=8, max_length=2048)
    code_challenge: str = Field(min_length=43, max_length=128)
    code_challenge_method: Literal["S256"]


class LaunchExchangeRequest(_StrictRequest):
    code: str = Field(min_length=20, max_length=256)
    verifier: str = Field(min_length=43, max_length=128)
    audience: str = Field(min_length=1, max_length=256)
    redirect_uri: str = Field(min_length=8, max_length=2048)


class LinkVerifyRequest(_StrictRequest):
    legacy_session_proof: str = Field(min_length=40, max_length=4096)


def _product_http_error(*, status_code: int, detail: dict[str, str]) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail=detail,
        headers={"Cache-Control": "private, no-store", "Pragma": "no-cache"},
    )


def _raise_client_error(exc: HushhTechClientError) -> None:
    raise _product_http_error(
        status_code=exc.status_code,
        detail={"code": exc.state, "message": exc.message},
    ) from exc


def _raise_upstream_unavailable(operation: str, exc: Exception) -> None:
    logger.warning("hushh_tech.%s_unavailable error=%s", operation, type(exc).__name__)
    raise _product_http_error(
        status_code=503,
        detail={"code": "UPSTREAM_UNAVAILABLE", "message": "Hushh Tech service unavailable."},
    ) from None


def _require_uat_cohort(firebase_uid: str) -> None:
    try:
        require_hushh_tech_client_admission(firebase_uid)
    except HushhTechClientError as exc:
        _raise_client_error(exc)


def _mark_secret_response(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"


def _direct_client_ip(request: Request) -> str:
    return get_trusted_forwarded_client_ip(
        request,
        trusted_proxy_hops_env=_TRUSTED_PROXY_HOPS_ENV,
    )


@lru_cache(maxsize=128)
def _verify_proxy_identity_token(token: str, audience: str) -> dict[str, Any]:
    claims = google_id_token.verify_oauth2_token(
        token,
        GoogleAuthRequest(),
        audience=audience,
    )
    return dict(claims)


def _verified_proxy_client_ip(request: Request) -> str:
    """Accept a claimed visitor IP only from an allowlisted Google identity."""
    fallback = _direct_client_ip(request)
    authorization = str(request.headers.get(_PROXY_AUTHORIZATION_HEADER) or "").strip()
    claimed_ip = str(request.headers.get(_PROXY_CLIENT_IP_HEADER) or "").strip()
    if not authorization and not claimed_ip:
        return fallback
    if not authorization.startswith("Bearer ") or not claimed_ip:
        return fallback

    audience = str(os.getenv("HUSSH_TECH_PROXY_AUDIENCE") or "").strip()
    allowed_accounts = {
        item.strip().lower()
        for item in str(os.getenv("HUSSH_TECH_TRUSTED_PROXY_SERVICE_ACCOUNTS") or "").split(",")
        if item.strip()
    }
    if not audience or not allowed_accounts:
        return fallback
    try:
        parsed_ip = str(ipaddress.ip_address(claimed_ip))
        token = authorization.removeprefix("Bearer ").strip()
        if not token or len(token) > 8192:
            return fallback
        claims = _verify_proxy_identity_token(token, audience)
        email = str(claims.get("email") or "").strip().lower()
        expires_at = int(claims.get("exp") or 0)
        if (
            email not in allowed_accounts
            or claims.get("email_verified") is not True
            or expires_at <= int(time.time())
        ):
            return fallback
    except Exception as exc:
        logger.warning("hushh_tech.proxy_identity_rejected error=%s", type(exc).__name__)
        return fallback
    return parsed_ip


def _consume_product_budget_or_raise(*, limit_value: str, scope: str, key: str) -> None:
    try:
        allowed = consume_shared_rate_limit_budget(
            limit_value=limit_value,
            scope=scope,
            key=key,
        )
    except Exception as exc:
        _raise_upstream_unavailable("rate_limit", exc)
    if not allowed:
        raise _product_http_error(
            status_code=429,
            detail={"code": "RATE_LIMITED", "message": "Try again shortly."},
        )


async def _consume_proxy_aware_budget(
    request: Request,
    *,
    limit_value: str,
    scope: str,
) -> None:
    direct_key = f"hushh_tech_ingress:{_direct_client_ip(request)}"
    _consume_product_budget_or_raise(
        limit_value=RateLimits.HUSHH_TECH_PROXY_ATTESTATION,
        scope="hushh_tech_proxy_attestation",
        key=direct_key,
    )
    visitor_ip = await run_in_threadpool(_verified_proxy_client_ip, request)
    _consume_product_budget_or_raise(
        limit_value=limit_value,
        scope=scope,
        key=f"hushh_tech_product:{visitor_ip}",
    )


async def require_hushh_tech_firebase_auth(
    request: Request,
    authorization: str | None = Header(default=None),
) -> str:
    """Verify Firebase without scheduling identity writes before cohort admission."""
    if not hushh_tech_client_enabled():
        _raise_client_error(
            HushhTechClientError(
                "FEATURE_DISABLED",
                "Hushh Tech entry is not enabled.",
                status_code=404,
            )
        )
    await _consume_proxy_aware_budget(
        request,
        limit_value=RateLimits.HUSHH_TECH_FIREBASE_PREAUTH,
        scope="hushh_tech_firebase_preauth",
    )
    try:
        firebase_uid = await run_in_threadpool(verify_firebase_bearer, authorization)
    except HTTPException as exc:
        if exc.status_code < 500:
            _raise_client_error(
                HushhTechClientError(
                    "UNAUTHENTICATED",
                    "Sign-in required.",
                    status_code=401,
                )
            )
        _raise_upstream_unavailable("firebase_auth", exc)
    _require_uat_cohort(firebase_uid)
    request.state.rate_limit_user_id = f"firebase:{firebase_uid}"
    return firebase_uid


def _configured_app_id() -> str:
    return str(os.getenv("HUSSH_TECH_DEVELOPER_APP_ID", "")).strip()


def _require_product_principal(
    *,
    request: Request,
    developer_token: str | None,
) -> str:
    """Authenticate one server-only product registration and no broader app."""
    expected_app_id = _configured_app_id()
    if not expected_app_id:
        raise _product_http_error(
            status_code=404,
            detail={"code": "FEATURE_DISABLED", "message": "Hushh Tech entry is not enabled."},
        )
    raw_token = str(developer_token or "").strip()
    try:
        principal = authenticate_developer_principal(
            authorization=f"Bearer {raw_token}" if raw_token else None,
            request=request,
        )
    except HTTPException as exc:
        if exc.status_code == 401:
            raise _product_http_error(
                status_code=401,
                detail={"code": "UNAUTHENTICATED", "message": "Product access required."},
            ) from None
        if 400 <= exc.status_code < 500:
            raise _product_http_error(
                status_code=403,
                detail={
                    "code": "FEATURE_DISABLED",
                    "message": "This product registration is not enabled.",
                },
            ) from None
        _raise_upstream_unavailable("developer_auth", exc)
    except Exception as exc:
        _raise_upstream_unavailable("developer_auth", exc)
    exact_groups = tuple(principal.allowed_tool_groups) == (TOOL_GROUP_HUSHH_TECH_CLIENT,)
    if (
        principal.app_id != expected_app_id
        or not exact_groups
        or tuple(principal.allowed_capabilities)
        or principal.auth_source != "registry"
    ):
        raise _product_http_error(
            status_code=403,
            detail={
                "code": "FEATURE_DISABLED",
                "message": "This product registration is not allowed for Hushh Tech entry.",
            },
        )
    return expected_app_id


async def _ensure_canonical_actor(firebase_uid: str) -> None:
    """Close the first-entry race before writing a Firebase-UID foreign key."""
    try:
        actor = await ActorIdentityService().upsert_identity(
            user_id=firebase_uid,
            source="firebase_verified_session",
        )
    except Exception as exc:
        logger.warning("hushh_tech.actor_sync_unavailable error=%s", type(exc).__name__)
        raise _product_http_error(
            status_code=503,
            detail={"code": "UPSTREAM_UNAVAILABLE", "message": "Account service unavailable."},
        ) from None
    if not actor:
        raise _product_http_error(
            status_code=503,
            detail={"code": "UPSTREAM_UNAVAILABLE", "message": "Account service unavailable."},
        )


async def _require_recent_firebase_auth(
    *,
    authorization: str | None,
    firebase_uid: str,
    now_seconds: int | None = None,
) -> None:
    """Require a non-replayed, at-most-five-minute-old Firebase sign-in."""
    raw = str(authorization or "").strip()
    if not raw.startswith("Bearer ") or not raw.removeprefix("Bearer ").strip():
        raise _product_http_error(
            status_code=401,
            detail={"code": "UNAUTHENTICATED", "message": "Recent sign-in required."},
        )
    app = get_firebase_auth_app()
    if app is None:
        raise _product_http_error(
            status_code=503,
            detail={"code": "UPSTREAM_UNAVAILABLE", "message": "Sign-in service unavailable."},
        )
    try:
        from firebase_admin import auth as firebase_auth

        decoded = await run_in_threadpool(
            firebase_auth.verify_id_token,
            raw.removeprefix("Bearer ").strip(),
            app=app,
            check_revoked=True,
        )
    except Exception:
        raise _product_http_error(
            status_code=401,
            detail={"code": "UNAUTHENTICATED", "message": "Recent sign-in required."},
        ) from None

    token_uid = str(decoded.get("uid") or "")
    auth_time = decoded.get("auth_time")
    current = int(time.time()) if now_seconds is None else int(now_seconds)
    if (
        token_uid != firebase_uid
        or isinstance(auth_time, bool)
        or not isinstance(auth_time, (int, float))
        or int(auth_time) > current + 30
        or current - int(auth_time) > _RECENT_AUTH_MAX_AGE_SECONDS
    ):
        raise _product_http_error(
            status_code=401,
            detail={"code": "UNAUTHENTICATED", "message": "Recent sign-in required."},
        )


async def _firebase_custom_token(
    *,
    firebase_uid: str,
    audience: str,
    app_id: str,
    launch_authorization_id: str,
    launch_valid_after_ms: int,
) -> str:
    app = get_firebase_auth_app()
    if app is None:
        raise _product_http_error(
            status_code=503,
            detail={"code": "UPSTREAM_UNAVAILABLE", "message": "Sign-in service unavailable."},
        )
    try:
        from firebase_admin import auth as firebase_auth

        custom_token = await run_in_threadpool(
            firebase_auth.create_custom_token,
            firebase_uid,
            {
                "product_client": "hushh-tech",
                "product_client_app_id": app_id,
                "product_audience": audience,
                "product_launch_authorization_id": launch_authorization_id,
                "product_launch_valid_after_ms": launch_valid_after_ms,
            },
            app=app,
        )
    except Exception as exc:
        logger.warning("hushh_tech.custom_token_failed error=%s", type(exc).__name__)
        raise _product_http_error(
            status_code=503,
            detail={"code": "UPSTREAM_UNAVAILABLE", "message": "Sign-in service unavailable."},
        ) from None
    return custom_token.decode("utf-8") if isinstance(custom_token, bytes) else str(custom_token)


async def _firebase_valid_after_ms(firebase_uid: str) -> int:
    """Return the current Firebase revocation watermark for one active user."""
    app = get_firebase_auth_app()
    if app is None:
        raise _product_http_error(
            status_code=503,
            detail={"code": "UPSTREAM_UNAVAILABLE", "message": "Sign-in service unavailable."},
        )
    try:
        from firebase_admin import auth as firebase_auth

        user = await run_in_threadpool(firebase_auth.get_user, firebase_uid, app=app)
    except Exception as exc:
        from firebase_admin import auth as firebase_auth

        if isinstance(exc, firebase_auth.UserNotFoundError):
            raise _product_http_error(
                status_code=401,
                detail={"code": "UNAUTHENTICATED", "message": "Sign-in required."},
            ) from None
        logger.warning("hushh_tech.firebase_user_lookup_failed error=%s", type(exc).__name__)
        raise _product_http_error(
            status_code=503,
            detail={"code": "UPSTREAM_UNAVAILABLE", "message": "Sign-in service unavailable."},
        ) from None
    if bool(getattr(user, "disabled", False)):
        raise _product_http_error(
            status_code=401,
            detail={"code": "UNAUTHENTICATED", "message": "Sign-in required."},
        )
    try:
        return max(0, int(getattr(user, "tokens_valid_after_timestamp", 0) or 0))
    except (TypeError, ValueError):
        logger.warning("hushh_tech.firebase_user_watermark_invalid")
        raise _product_http_error(
            status_code=503,
            detail={"code": "UPSTREAM_UNAVAILABLE", "message": "Sign-in service unavailable."},
        ) from None


def _require_unchanged_firebase_watermark(*, expected: int, current: int) -> None:
    if expected != current:
        raise _product_http_error(
            status_code=401,
            detail={"code": "UNAUTHENTICATED", "message": "Sign-in required."},
        )


async def _authorize_firebase_watermark(
    *,
    authorization: str | None,
    firebase_uid: str,
) -> int:
    """Bind the exact authorizing ID token to the current revocation watermark."""
    raw = str(authorization or "").strip()
    if not raw.startswith("Bearer ") or not raw.removeprefix("Bearer ").strip():
        raise _product_http_error(
            status_code=401,
            detail={"code": "UNAUTHENTICATED", "message": "Sign-in required."},
        )
    app = get_firebase_auth_app()
    if app is None:
        raise _product_http_error(
            status_code=503,
            detail={"code": "UPSTREAM_UNAVAILABLE", "message": "Sign-in service unavailable."},
        )
    try:
        from firebase_admin import auth as firebase_auth

        decoded = await run_in_threadpool(
            firebase_auth.verify_id_token,
            raw.removeprefix("Bearer ").strip(),
            app=app,
            check_revoked=True,
        )
    except Exception:
        raise _product_http_error(
            status_code=401,
            detail={"code": "UNAUTHENTICATED", "message": "Sign-in required."},
        ) from None
    token_uid = str(decoded.get("uid") or "")
    issued_at = decoded.get("iat")
    if (
        token_uid != firebase_uid
        or isinstance(issued_at, bool)
        or not isinstance(issued_at, (int, float))
    ):
        raise _product_http_error(
            status_code=401,
            detail={"code": "UNAUTHENTICATED", "message": "Sign-in required."},
        )
    watermark = await _firebase_valid_after_ms(firebase_uid)
    if int(issued_at) * 1000 < watermark:
        raise _product_http_error(
            status_code=401,
            detail={"code": "UNAUTHENTICATED", "message": "Sign-in required."},
        )
    return watermark


@router.post("/launch/authorize")
@limiter.shared_limit(
    RateLimits.HUSHH_TECH_LAUNCH_AUTHORIZE,
    "hushh_tech_launch_authorize",
    key_func=get_rate_limit_key,
)
async def authorize_launch(
    request: Request,
    payload: LaunchAuthorizeRequest,
    response: Response,
    firebase_uid: str = Depends(require_hushh_tech_firebase_auth),
    authorization: str | None = Header(default=None),
):
    _require_uat_cohort(firebase_uid)
    firebase_valid_after_ms = await _authorize_firebase_watermark(
        authorization=authorization,
        firebase_uid=firebase_uid,
    )
    await _ensure_canonical_actor(firebase_uid)
    try:
        launch_authorization = cast(
            _LaunchAuthorizationResult,
            await HushhTechClientService().authorize_launch(
                firebase_uid=firebase_uid,
                audience=payload.audience,
                redirect_uri=payload.redirect_uri,
                code_challenge=payload.code_challenge,
                code_challenge_method=payload.code_challenge_method,
                firebase_valid_after_ms=firebase_valid_after_ms,
            ),
        )
    except HushhTechClientError as exc:
        _raise_client_error(exc)
    except Exception as exc:
        _raise_upstream_unavailable("launch_authorize", exc)
    _mark_secret_response(response)
    return {
        "code": launch_authorization.code,
        "expires_in": 60,
        "audience": launch_authorization.audience,
        "redirect_uri": launch_authorization.redirect_uri,
    }


@router.post("/launch/exchange")
async def exchange_launch(
    request: Request,
    payload: LaunchExchangeRequest,
    response: Response,
):
    await _consume_proxy_aware_budget(
        request,
        limit_value=RateLimits.HUSHH_TECH_LAUNCH_EXCHANGE,
        scope="hushh_tech_launch_exchange_visitor",
    )
    try:
        exchange = await HushhTechClientService().exchange_launch(
            code=payload.code,
            code_verifier=payload.verifier,
            audience=payload.audience,
            redirect_uri=payload.redirect_uri,
        )
        firebase_uid = str(exchange["firebase_uid"])
        expected_valid_after_ms = int(exchange.get("firebase_valid_after_ms") or 0)
        current_valid_after_ms = await _firebase_valid_after_ms(firebase_uid)
        _require_unchanged_firebase_watermark(
            expected=expected_valid_after_ms,
            current=current_valid_after_ms,
        )
        app_id = _configured_app_id()
        if not app_id:
            raise HushhTechClientError(
                "FEATURE_DISABLED",
                "Hushh Tech entry is not enabled.",
                status_code=404,
            )
        custom_token = await _firebase_custom_token(
            firebase_uid=firebase_uid,
            audience=str(exchange["audience"]),
            app_id=app_id,
            launch_authorization_id=str(exchange["authorization_id"]),
            launch_valid_after_ms=expected_valid_after_ms,
        )
        current_valid_after_ms = await _firebase_valid_after_ms(firebase_uid)
        _require_unchanged_firebase_watermark(
            expected=expected_valid_after_ms,
            current=current_valid_after_ms,
        )
        link = await HushhTechClientService().get_link_status(
            firebase_uid=firebase_uid,
            app_id=app_id,
        )
    except HushhTechClientError as exc:
        _raise_client_error(exc)
    except HTTPException:
        raise
    except Exception as exc:
        _raise_upstream_unavailable("launch_exchange", exc)
    _mark_secret_response(response)
    return {
        "firebase_custom_token": custom_token,
        "expires_in": 3600,
        "canonical_user_id": firebase_uid,
        "audience": str(exchange["audience"]),
        "state": str(link["state"]),
    }


@router.get("/link/status")
@limiter.shared_limit(
    RateLimits.HUSHH_TECH_CLIENT_READ,
    "hushh_tech_link_status",
    key_func=get_rate_limit_key,
)
async def link_status(
    request: Request,
    response: Response,
    firebase_uid: str = Depends(require_hushh_tech_firebase_auth),
    developer_token: str | None = Header(default=None, alias="X-Hushh-Developer-Token"),
):
    app_id = _require_product_principal(request=request, developer_token=developer_token)
    try:
        result = await HushhTechClientService().get_link_status(
            firebase_uid=firebase_uid,
            app_id=app_id,
        )
    except HushhTechClientError as exc:
        _raise_client_error(exc)
    except Exception as exc:
        _raise_upstream_unavailable("link_status", exc)
    _mark_secret_response(response)
    return result


@router.post("/link/verify")
@limiter.shared_limit(
    RateLimits.HUSHH_TECH_LINK_WRITE,
    "hushh_tech_link_write",
    key_func=get_rate_limit_key,
)
async def verify_link(
    payload: LinkVerifyRequest,
    request: Request,
    response: Response,
    firebase_uid: str = Depends(require_hushh_tech_firebase_auth),
    authorization: str | None = Header(default=None),
    developer_token: str | None = Header(default=None, alias="X-Hushh-Developer-Token"),
):
    app_id = _require_product_principal(request=request, developer_token=developer_token)
    await _require_recent_firebase_auth(
        authorization=authorization,
        firebase_uid=firebase_uid,
    )
    _require_uat_cohort(firebase_uid)
    await _ensure_canonical_actor(firebase_uid)
    try:
        result = await HushhTechClientService().verify_and_link_account(
            firebase_uid=firebase_uid,
            app_id=app_id,
            legacy_session_proof=payload.legacy_session_proof,
            legacy_proof_signing_key=str(developer_token or "").strip(),
        )
    except HushhTechClientError as exc:
        _raise_client_error(exc)
    except Exception as exc:
        _raise_upstream_unavailable("link_verify", exc)
    _mark_secret_response(response)
    return result


@router.post("/link/revoke")
@limiter.shared_limit(
    RateLimits.HUSHH_TECH_LINK_WRITE,
    "hushh_tech_link_write",
    key_func=get_rate_limit_key,
)
async def revoke_link(
    request: Request,
    response: Response,
    firebase_uid: str = Depends(require_hushh_tech_firebase_auth),
    authorization: str | None = Header(default=None),
    developer_token: str | None = Header(default=None, alias="X-Hushh-Developer-Token"),
):
    app_id = _require_product_principal(request=request, developer_token=developer_token)
    await _require_recent_firebase_auth(
        authorization=authorization,
        firebase_uid=firebase_uid,
    )
    try:
        result = await HushhTechClientService().revoke_link(
            firebase_uid=firebase_uid,
            app_id=app_id,
        )
    except HushhTechClientError as exc:
        _raise_client_error(exc)
    except Exception as exc:
        _raise_upstream_unavailable("link_revoke", exc)
    _mark_secret_response(response)
    return result


@router.get("/compatibility/{record_type}")
@limiter.shared_limit(
    RateLimits.HUSHH_TECH_CLIENT_READ,
    "hushh_tech_compatibility_read",
    key_func=get_rate_limit_key,
)
async def get_compatibility_record(
    record_type: str,
    request: Request,
    response: Response,
    firebase_uid: str = Depends(require_hushh_tech_firebase_auth),
    developer_token: str | None = Header(default=None, alias="X-Hushh-Developer-Token"),
) -> dict[str, Any]:
    app_id = _require_product_principal(request=request, developer_token=developer_token)
    try:
        result = cast(
            dict[str, Any],
            await HushhTechClientService().get_shadow(
                firebase_uid=firebase_uid,
                app_id=app_id,
                record_type=record_type,
            ),
        )
    except HushhTechClientError as exc:
        _raise_client_error(exc)
    except Exception as exc:
        _raise_upstream_unavailable("compatibility_read", exc)
    _mark_secret_response(response)
    return result


__all__ = ["router"]
