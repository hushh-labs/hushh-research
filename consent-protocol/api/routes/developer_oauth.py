"""Inbound MCP OAuth discovery, registration and user authorization routes."""

from __future__ import annotations

import base64
import binascii
import json
import os
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Path, Query, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.concurrency import run_in_threadpool

from api.developer_auth import developer_api_disabled_error, developer_api_enabled
from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import limiter
from hushh_mcp.runtime_settings import get_app_runtime_settings
from hushh_mcp.services.developer_oauth_service import (
    DeveloperOAuthService,
    OAuthClient,
    OAuthValidationError,
    append_oauth_parameters,
)

router = APIRouter()
oauth_router = APIRouter(prefix="/oauth", tags=["Developer OAuth"])


def _oauth_frontend_authorize_url(transaction_ref: str) -> str:

    origin = (
        str(get_app_runtime_settings().app_frontend_origin or "http://localhost:3000")
        .strip()
        .rstrip("/")
    )
    return f"{origin}/oauth/authorize?{urlencode({'request': transaction_ref})}"


def _oauth_public_origin(request: Request) -> str:
    configured = str(os.getenv("CONSENT_API_PUBLIC_ORIGIN") or "").strip().rstrip("/")
    if configured:
        return configured
    return str(request.base_url).rstrip("/")


def _oauth_client_credentials(request: Request, form: dict[str, Any]) -> tuple[str, str | None]:
    authorization = str(request.headers.get("authorization") or "").strip()
    if authorization.lower().startswith("basic "):
        encoded = authorization[6:].strip()
        try:
            decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
            client_id, client_secret = decoded.split(":", 1)
        except (ValueError, UnicodeDecodeError, binascii.Error) as exc:
            raise OAuthValidationError("invalid_client", "Client authentication failed.") from exc
        return client_id, client_secret
    return str(form.get("client_id") or "").strip(), str(
        form.get("client_secret") or ""
    ).strip() or None


@router.get("/.well-known/oauth-protected-resource")
@router.get("/.well-known/oauth-protected-resource/mcp/")
async def oauth_protected_resource_metadata(request: Request):
    if not developer_api_enabled():
        raise developer_api_disabled_error()
    origin = _oauth_public_origin(request)
    return {
        "resource": f"{origin}/mcp/",
        "authorization_servers": [origin],
        "scopes_supported": ["mcp:tools"],
        "bearer_methods_supported": ["header"],
    }


@oauth_router.post("/register", status_code=201)
@limiter.limit("30/minute")
async def oauth_register(request: Request):
    from hushh_mcp.services.oauth_client_registration import (
        MAX_METADATA_BYTES,
        OAuthClientRegistration,
    )

    if not developer_api_enabled():
        raise developer_api_disabled_error()
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_METADATA_BYTES:
            return JSONResponse({"error": "invalid_client_metadata"}, status_code=413)
        body.extend(chunk)
    try:
        metadata = json.loads(body)
        result = await run_in_threadpool(
            OAuthClientRegistration(DeveloperOAuthService()).register, metadata
        )
        return JSONResponse(result, status_code=201, headers={"Cache-Control": "no-store"})
    except (ValueError, UnicodeDecodeError) as error:
        code = error.code if isinstance(error, OAuthValidationError) else "invalid_client_metadata"
        return JSONResponse({"error": code}, status_code=400)


def _oauth_failure(error: OAuthValidationError, status_code: int = 400) -> JSONResponse:
    return JSONResponse(
        {"error": error.code, "error_description": error.message},
        status_code=status_code,
        headers={"Cache-Control": "no-store"},
    )


def _validate_oauth_resource(resource: str | None) -> None:
    from hushh_mcp.services.developer_oauth_service import mcp_resource_identifier

    if resource is not None and resource != mcp_resource_identifier():
        raise OAuthValidationError(
            "invalid_target", "Only the canonical MCP resource is supported."
        )


def _validate_client_auth_method(request: Request, client: OAuthClient, secret: str | None) -> None:
    if client.registration_method == "portal":
        return  # Existing confidential clients support both basic and post.
    actual = (
        "client_secret_basic"
        if request.headers.get("authorization", "").lower().startswith("basic ")
        else ("client_secret_post" if secret is not None else "none")
    )
    if actual != client.token_endpoint_auth_method:
        raise OAuthValidationError("invalid_client", "Client authentication method does not match.")


@router.get("/.well-known/oauth-authorization-server")
async def oauth_authorization_server_metadata(request: Request):
    if not developer_api_enabled():
        raise developer_api_disabled_error()
    origin = _oauth_public_origin(request)
    return {
        "issuer": origin,
        "authorization_endpoint": f"{origin}/oauth/authorize",
        "token_endpoint": f"{origin}/oauth/token",
        "revocation_endpoint": f"{origin}/oauth/revoke",
        "registration_endpoint": f"{origin}/oauth/register",
        "client_id_metadata_document_supported": True,
        "authorization_response_iss_parameter_supported": True,
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token", "client_credentials"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": [
            "none",
            "client_secret_basic",
            "client_secret_post",
        ],
        "scopes_supported": ["mcp:tools"],
    }


@oauth_router.get("/authorize")
@limiter.limit("60/minute")
async def oauth_authorize(
    request: Request,
    response_type: str = Query(..., max_length=32),
    client_id: str = Query(..., min_length=8, max_length=2048),
    redirect_uri: str = Query(..., min_length=8, max_length=2048),
    code_challenge: str = Query(..., min_length=43, max_length=128),
    code_challenge_method: str = Query(..., max_length=16),
    state: str | None = Query(default=None, max_length=512),
    scope: str | None = Query(default=None, max_length=128),
    resource: str | None = Query(default=None, max_length=2048),
):
    if not developer_api_enabled():
        raise developer_api_disabled_error()
    if response_type != "code" or code_challenge_method != "S256":
        return _oauth_failure(
            OAuthValidationError(
                "unsupported_response_type", "Only authorization code with S256 PKCE is supported."
            ),
        )
    try:
        from hushh_mcp.services.oauth_client_registration import OAuthClientRegistration

        _validate_oauth_resource(resource)
        oauth = DeveloperOAuthService()
        if client_id.startswith("https://"):
            await OAuthClientRegistration(oauth).resolve(client_id)
        transaction_ref = await run_in_threadpool(
            oauth.begin_authorization,
            client_id=client_id,
            redirect_uri=redirect_uri,
            code_challenge=code_challenge,
            state=state,
            scope=scope,
            **({"resource": resource} if resource is not None else {}),
        )
    except OAuthValidationError as error:
        return _oauth_failure(error)
    return RedirectResponse(
        _oauth_frontend_authorize_url(transaction_ref), status_code=status.HTTP_303_SEE_OTHER
    )


@oauth_router.get("/authorize/{transaction_ref}")
async def oauth_authorization_review(
    transaction_ref: str = Path(..., pattern=r"^oar_[a-f0-9]{32}$", max_length=36),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        result = await run_in_threadpool(
            DeveloperOAuthService().authorization_review, transaction_ref=transaction_ref
        )
        return JSONResponse(result, headers={"Cache-Control": "no-store"})
    except OAuthValidationError as error:
        return _oauth_failure(error)


@oauth_router.post("/authorize/{transaction_ref}/approve")
async def approve_oauth_authorization(
    request: Request,
    transaction_ref: str = Path(..., pattern=r"^oar_[a-f0-9]{32}$", max_length=36),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        # The browser only receives an OAuth authorization code after its One
        # account authenticated.  No consent grant or protected information is
        # included in this response.
        oauth = DeveloperOAuthService()
        code = oauth.approve_authorization(
            transaction_ref=transaction_ref, subject_firebase_uid=firebase_uid
        )
        redirect = oauth.authorization_redirect(transaction_ref=transaction_ref)
        if redirect is None:  # defensive; successful approval above establishes it
            raise OAuthValidationError(
                "invalid_request", "This authorization request is no longer available."
            )
        return {
            "redirect_uri": append_oauth_parameters(
                redirect["redirect_uri"],
                {"code": code, "state": redirect["state"], "iss": _oauth_public_origin(request)},
            )
        }
    except OAuthValidationError as error:
        return _oauth_failure(error)


@oauth_router.post("/authorize/{transaction_ref}/deny")
async def deny_oauth_authorization(
    request: Request,
    transaction_ref: str = Path(..., pattern=r"^oar_[a-f0-9]{32}$", max_length=36),
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        result = DeveloperOAuthService().deny_authorization(
            transaction_ref=transaction_ref, subject_firebase_uid=firebase_uid
        )
        return {
            "redirect_uri": append_oauth_parameters(
                result["redirect_uri"],
                {
                    "error": "access_denied",
                    "state": result["state"],
                    "iss": _oauth_public_origin(request),
                },
            )
        }
    except OAuthValidationError as error:
        return _oauth_failure(error)


@oauth_router.post("/token")
async def oauth_token(request: Request):
    if not developer_api_enabled():
        raise developer_api_disabled_error()
    form = {str(key): value for key, value in (await request.form()).items()}
    try:
        client_id, client_secret = _oauth_client_credentials(request, form)
        oauth = DeveloperOAuthService()
        client = await run_in_threadpool(
            oauth.verify_client_secret, client_id=client_id, client_secret=client_secret
        )
        _validate_client_auth_method(request, client, client_secret)
        resource = str(form.get("resource") or "") or None
        _validate_oauth_resource(resource)
        resource_args = {"resource": resource} if resource is not None else {}
        if "client_assertion" in form or "client_assertion_type" in form:
            raise OAuthValidationError(
                "invalid_client", "Signed client assertions are not supported."
            )
        grant_type = str(form.get("grant_type") or "")
        if grant_type == "authorization_code":
            return JSONResponse(
                await run_in_threadpool(
                    oauth.exchange_authorization_code,
                    client=client,
                    code=str(form.get("code") or ""),
                    redirect_uri=str(form.get("redirect_uri") or ""),
                    code_verifier=str(form.get("code_verifier") or ""),
                    **resource_args,
                ),
                headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
            )
        if grant_type == "refresh_token":
            return JSONResponse(
                await run_in_threadpool(
                    oauth.refresh,
                    client=client,
                    refresh_token=str(form.get("refresh_token") or ""),
                    **resource_args,
                ),
                headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
            )
        if grant_type == "client_credentials":
            return DeveloperOAuthService().issue_client_credentials(
                client=client,
                scope=str(form.get("scope") or ""),
            )
        raise OAuthValidationError(
            "unsupported_grant_type",
            "Supported grants are authorization_code, refresh_token, and client_credentials.",
        )
    except OAuthValidationError as error:
        return _oauth_failure(error, 401 if error.code == "invalid_client" else 400)


@oauth_router.post("/revoke", status_code=status.HTTP_200_OK)
async def oauth_revoke(request: Request):
    if not developer_api_enabled():
        raise developer_api_disabled_error()
    form = {str(key): value for key, value in (await request.form()).items()}
    try:
        client_id, client_secret = _oauth_client_credentials(request, form)
        oauth = DeveloperOAuthService()
        client = await run_in_threadpool(
            oauth.verify_client_secret, client_id=client_id, client_secret=client_secret
        )
        _validate_client_auth_method(request, client, client_secret)
        DeveloperOAuthService().revoke(client=client, token=str(form.get("token") or ""))
    except OAuthValidationError as error:
        return _oauth_failure(error, 401)
    return Response(status_code=status.HTTP_200_OK)


router.include_router(oauth_router)
