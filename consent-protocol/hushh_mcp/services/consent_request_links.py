from __future__ import annotations

import os
from urllib.parse import urlencode

from hushh_mcp.runtime_settings import get_app_runtime_settings


def frontend_origin() -> str:
    origin = get_app_runtime_settings().app_frontend_origin
    if not origin:
        origin = str(os.getenv("NEXT_PUBLIC_APP_URL", "http://localhost:3000")).strip().rstrip("/")
    return origin or "http://localhost:3000"


# Tab vocabulary the consent center actually understands (see
# hushh-webapp/components/consent/consent-center-page.tsx ConsentTab +
# normalizeTab). Links must never mint tab values outside this contract:
# unrecognized tabs silently fall back to the requests tab, which hides
# the drift instead of surfacing it.
_VALID_CONSENT_TABS = {"pending", "active", "history", "connections"}
_CONSENT_TAB_ALIASES = {
    "requests": "pending",
    "previous": "history",
    "relationships": "connections",
    # Status-like caller vocabulary: an "incoming" request is a pending one.
    "incoming": "pending",
}


def normalize_consent_tab(view: str | None) -> str:
    candidate = str(view or "").strip().lower()
    candidate = _CONSENT_TAB_ALIASES.get(candidate, candidate)
    return candidate if candidate in _VALID_CONSENT_TABS else "pending"


def build_consent_request_path(
    *,
    request_id: str | None = None,
    bundle_id: str | None = None,
    view: str = "pending",
    actor: str | None = None,
    manager_view: str | None = None,
) -> str:
    params: dict[str, str] = {"tab": normalize_consent_tab(view)}
    if request_id:
        params["requestId"] = request_id
    if bundle_id:
        params["bundleId"] = bundle_id
    if actor in {"investor", "ria"}:
        params["actor"] = actor
    if manager_view in {"incoming", "outgoing"}:
        params["view"] = manager_view
    return f"/consents?{urlencode(params)}"


def build_consent_request_url(
    *,
    request_id: str | None = None,
    bundle_id: str | None = None,
    view: str = "pending",
    actor: str | None = None,
    manager_view: str | None = None,
) -> str:
    return f"{frontend_origin()}{build_consent_request_path(request_id=request_id, bundle_id=bundle_id, view=view, actor=actor, manager_view=manager_view)}"


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
