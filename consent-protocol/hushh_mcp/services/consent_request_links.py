from __future__ import annotations

import os
from urllib.parse import urlencode

FRONTEND_ORIGIN_ENV_KEY = "FRONTEND_URL"
LOCALHOST_FRONTEND_ORIGIN = "http://localhost:3000"


def frontend_origin() -> str:
    origin = str(os.getenv(FRONTEND_ORIGIN_ENV_KEY, LOCALHOST_FRONTEND_ORIGIN)).strip().rstrip(
        "/"
    )
    return origin or LOCALHOST_FRONTEND_ORIGIN


def build_consent_request_path(
    *,
    request_id: str | None = None,
    bundle_id: str | None = None,
    view: str = "pending",
) -> str:
    params: dict[str, str] = {
        "tab": "privacy",
        "sheet": "consents",
        "consentView": view or "pending",
    }
    if request_id:
        params["requestId"] = request_id
    if bundle_id:
        params["bundleId"] = bundle_id
    return f"/profile?{urlencode(params)}"


def build_consent_request_url(
    *,
    request_id: str | None = None,
    bundle_id: str | None = None,
    view: str = "pending",
) -> str:
    return f"{frontend_origin()}{build_consent_request_path(request_id=request_id, bundle_id=bundle_id, view=view)}"


def build_connection_request_path(
    *,
    selected: str | None = None,
    tab: str = "pending",
) -> str:
    params: dict[str, str] = {"tab": tab or "pending"}
    if selected:
        params["selected"] = selected
    return f"/marketplace/connections?{urlencode(params)}"


def build_connection_request_url(
    *,
    selected: str | None = None,
    tab: str = "pending",
) -> str:
    return f"{frontend_origin()}{build_connection_request_path(selected=selected, tab=tab)}"
