"""Loopback-only OAuth exchange for the UAT hosted Mail sandbox.

Only this container receives the dedicated web client secret. The fixed Google
destination and client never come from the owner process. No request logging.
"""

import json
import os

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from hushh_mcp.services.pod_google_oauth import TOKEN_URL, UAT_MAIL_ORIGIN

app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)


@app.post("/exchange")
async def exchange(request: Request) -> JSONResponse:
    from hushh_mcp.services.pod_connector_credential_seal import allowed_scopes  # noqa: PLC0415

    refused = JSONResponse({"error": "invalid_request"}, status_code=400)
    if (
        request.headers.get("host") != "127.0.0.1:8764"
        or request.headers.get("content-type") != "application/json"
    ):
        return refused
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > 16384:
            return refused
        raw.extend(chunk)

    try:
        form = json.loads(raw)
    except (ValueError, UnicodeError):
        return refused
    if not isinstance(form, dict) or not all(isinstance(v, str) and v for v in form.values()):
        return refused
    client = os.environ.get("GOOGLE_UAT_MAIL_WEB_CLIENT_ID")
    secret = os.environ.get("GOOGLE_UAT_MAIL_WEB_CLIENT_SECRET")
    if not client or not secret or form.get("client_id") != client:
        return refused
    if form.get("grant_type") == "authorization_code":
        if (
            set(form) != {"grant_type", "client_id", "code", "redirect_uri"}
            or form["redirect_uri"] != UAT_MAIL_ORIGIN
        ):
            return refused
    elif form.get("grant_type") == "refresh_token":
        if set(form) != {"grant_type", "client_id", "refresh_token", "scope"} or not set(
            form["scope"].split()
        ) <= allowed_scopes("gmail"):
            return refused
    else:
        return refused
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as http:
            response = await http.post(TOKEN_URL, data={**form, "client_secret": secret})
            body = response.json()
    except (ValueError, httpx.HTTPError):
        return JSONResponse({"error": "temporarily_unavailable"}, status_code=503)
    if not isinstance(body, dict):
        return refused
    # Google diagnostics must never propagate confidential request inputs.
    if response.status_code != 200:
        return JSONResponse(
            {
                "error": "invalid_grant"
                if body.get("error") == "invalid_grant"
                else "provider_refused"
            },
            status_code=response.status_code,
        )
    scope = body.get("scope")
    if (
        not isinstance(scope, str)
        or not scope.split()
        or not set(scope.split()) <= allowed_scopes("gmail")
    ):
        return JSONResponse({"error": "invalid_scope"}, status_code=403)
    return JSONResponse(
        {
            k: body[k]
            for k in ("access_token", "refresh_token", "id_token", "scope", "expires_in")
            if k in body
        },
        headers={"Cache-Control": "no-store"},
    )
