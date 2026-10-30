"""
Firebase Admin initialization helpers.

Goal: a single, reliable initialization path for local dev + Cloud Run.

Credential sources (in priority order):
1) FIREBASE_ADMIN_CREDENTIALS_JSON
2) FIREBASE_SERVICE_ACCOUNT_JSON (legacy/runtime alias)
3) GOOGLE_APPLICATION_CREDENTIALS / ADC
"""

from __future__ import annotations

import json
from typing import Any, Optional, Tuple

from hushh_mcp.runtime_settings import (
    FIREBASE_ADMIN_CREDENTIALS_JSON_ENV,
    get_firebase_credential_settings,
)

DEFAULT_SERVICE_ACCOUNT_ENV = FIREBASE_ADMIN_CREDENTIALS_JSON_ENV


def _load_service_account_from_env(var_name: str) -> Optional[dict[str, Any]]:
    credential_settings = get_firebase_credential_settings()
    if var_name == DEFAULT_SERVICE_ACCOUNT_ENV:
        raw = credential_settings.admin_credentials_json
    else:
        raw = None
    if not raw:
        return None

    try:
        data = json.loads(raw)
    except Exception as e:
        raise RuntimeError(f"Invalid {var_name}: {type(e).__name__}") from e

    if not isinstance(data, dict) or data.get("type") != "service_account":
        raise RuntimeError(f"{var_name} must be a service_account JSON object")

    return data


def _project_id_from_app(app: Any, fallback: Optional[dict[str, Any]] = None) -> Optional[str]:
    project_id = app.project_id if hasattr(app, "project_id") else None
    if project_id:
        return str(project_id)
    if fallback and isinstance(fallback, dict):
        maybe = fallback.get("project_id")
        if isinstance(maybe, str) and maybe.strip():
            return maybe.strip()
    return None


def _project_id_from_service_account(service_account: Optional[dict[str, Any]]) -> Optional[str]:
    if not service_account or not isinstance(service_account, dict):
        return None
    maybe = service_account.get("project_id")
    if isinstance(maybe, str) and maybe.strip():
        return maybe.strip()
    return None


def _get_existing_app(name: str | None = None):
    import firebase_admin

    try:
        if name:
            return firebase_admin.get_app(name)
        return firebase_admin.get_app()
    except ValueError:
        return None


def ensure_firebase_admin() -> Tuple[bool, Optional[str]]:
    """
    Ensure Firebase Admin SDK is initialized.

    Returns:
      (configured, project_id)
    """
    import firebase_admin
    from firebase_admin import credentials

    # Already initialized
    app = _get_existing_app()
    if app is not None:
        proj = app.project_id if hasattr(app, "project_id") else None
        return True, proj

    sa = _load_service_account_from_env(DEFAULT_SERVICE_ACCOUNT_ENV)
    if sa:
        cred = credentials.Certificate(sa)
        app = firebase_admin.initialize_app(cred)
        return True, _project_id_from_app(app, sa)

    # Fall back to ADC (Cloud Run / local gcloud)
    try:
        cred = credentials.ApplicationDefault()
        app = firebase_admin.initialize_app(cred)
        return True, _project_id_from_app(app)
    except Exception:
        # Not configured (caller decides whether to 500/401)
        return False, None


def ensure_firebase_auth_admin() -> Tuple[bool, Optional[str]]:
    return ensure_firebase_admin()


def get_firebase_auth_app():
    """
    Return the Firebase app used for auth-only operations.
    """
    configured, _ = ensure_firebase_auth_admin()
    if not configured:
        return None

    return _get_existing_app()
