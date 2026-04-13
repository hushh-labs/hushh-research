"""
Firebase Admin initialization helpers.

Goal: a single, reliable initialization path for local dev + Cloud Run.

Credential sources (in priority order):
1) FIREBASE_SERVICE_ACCOUNT_JSON  (JSON string)
2) FIREBASE_AUTH_SERVICE_ACCOUNT_JSON (JSON string for auth-only operations)
2) GOOGLE_APPLICATION_CREDENTIALS / ADC
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional, Tuple

DEFAULT_SERVICE_ACCOUNT_ENV = "FIREBASE_SERVICE_ACCOUNT_JSON"
AUTH_SERVICE_ACCOUNT_ENV = "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON"
AUTH_APP_NAME = "firebase-auth"


def _load_service_account_from_env(var_name: str) -> Optional[dict[str, Any]]:
    raw = os.environ.get(var_name)
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
    """
    Ensure the Firebase Admin app used for ID token verification exists.

    When FIREBASE_AUTH_SERVICE_ACCOUNT_JSON is provided, use a dedicated named
    app so local/UAT runtimes can verify auth tokens from a different Firebase
    project than the default admin/FCM project. Otherwise fall back to the
    default Firebase Admin app.
    """
    import firebase_admin
    from firebase_admin import credentials

    auth_app = _get_existing_app(AUTH_APP_NAME)
    if auth_app is not None:
        return True, _project_id_from_app(auth_app)

    auth_sa = _load_service_account_from_env(AUTH_SERVICE_ACCOUNT_ENV)
    if auth_sa:
        cred = credentials.Certificate(auth_sa)
        auth_app = firebase_admin.initialize_app(cred, name=AUTH_APP_NAME)
        return True, _project_id_from_app(auth_app, auth_sa)

    return ensure_firebase_admin()


def get_firebase_auth_app():
    """
    Return the Firebase app used for auth-only operations.
    """
    configured, _ = ensure_firebase_auth_admin()
    if not configured:
        return None

    auth_app = _get_existing_app(AUTH_APP_NAME)
    if auth_app is not None:
        return auth_app

    return _get_existing_app()
