"""
Firebase Admin initialization helpers.

Goal: a single, reliable initialization path for local dev + Cloud Run.

Credential sources (in priority order):
1) FIREBASE_SERVICE_ACCOUNT_JSON  (JSON string)
2) GOOGLE_APPLICATION_CREDENTIALS / ADC
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional, Tuple

AUTH_APP_NAME = "hushh-auth"
DEFAULT_SERVICE_ACCOUNT_ENV = "FIREBASE_SERVICE_ACCOUNT_JSON"
AUTH_SERVICE_ACCOUNT_ENV = "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON"
logger = logging.getLogger(__name__)


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


def _project_id_from_service_account(
    service_account: Optional[dict[str, Any]],
) -> Optional[str]:
    if not service_account or not isinstance(service_account, dict):
        return None
    maybe = service_account.get("project_id")
    if isinstance(maybe, str) and maybe.strip():
        return maybe.strip()
    return None


def _ensure_named_app_from_service_account(
    *,
    app_name: str,
    env_var_name: str,
) -> Tuple[bool, Optional[str]]:
    import firebase_admin
    from firebase_admin import credentials

    service_account = _load_service_account_from_env(env_var_name)
    if not service_account:
        return False, None

    try:
        app = firebase_admin.get_app(app_name)
        return True, _project_id_from_app(app, service_account)
    except ValueError:
        pass

    cred = credentials.Certificate(service_account)
    app = firebase_admin.initialize_app(cred, name=app_name)
    return True, _project_id_from_app(app, service_account)


def ensure_firebase_admin() -> Tuple[bool, Optional[str]]:
    """
    Ensure Firebase Admin SDK is initialized.

    Returns:
      (configured, project_id)
    """
    import firebase_admin
    from firebase_admin import credentials

    # Already initialized
    try:
        app = firebase_admin.get_app()
        proj = app.project_id if hasattr(app, "project_id") else None
        return True, proj
    except ValueError:
        pass

    # Prefer the explicit default service account for the default Firebase app.
    # Auth-token verification may use a separate named app via
    # FIREBASE_AUTH_SERVICE_ACCOUNT_JSON; keep those concerns decoupled so local
    # UAT messaging can continue to use the UAT Firebase project while auth
    # verification uses the shared auth project.
    sa = _load_service_account_from_env(DEFAULT_SERVICE_ACCOUNT_ENV)
    auth_sa = _load_service_account_from_env(AUTH_SERVICE_ACCOUNT_ENV)
    selected_sa = sa or auth_sa

    default_project_id = _project_id_from_service_account(sa)
    auth_project_id = _project_id_from_service_account(auth_sa)
    if (
        sa
        and auth_sa
        and default_project_id
        and auth_project_id
        and default_project_id != auth_project_id
    ):
        logger.warning(
            "Firebase Admin default/auth project mismatch detected (default=%s auth=%s). Keeping default app on the default project and auth verification on the named auth app.",
            default_project_id,
            auth_project_id,
        )

    if selected_sa:
        cred = credentials.Certificate(selected_sa)
        app = firebase_admin.initialize_app(cred)
        return True, _project_id_from_app(app, selected_sa)

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
    Ensure auth-token verification Firebase app is initialized.

    Priority:
    1) FIREBASE_AUTH_SERVICE_ACCOUNT_JSON -> named app (AUTH_APP_NAME)
    2) Fallback to default app initialization via ensure_firebase_admin()
    """
    configured, project_id = _ensure_named_app_from_service_account(
        app_name=AUTH_APP_NAME,
        env_var_name=AUTH_SERVICE_ACCOUNT_ENV,
    )
    if configured:
        return configured, project_id
    return ensure_firebase_admin()


def get_firebase_auth_app():
    """
    Return Firebase app object for ID token verification.

    Uses auth-specific named app when FIREBASE_AUTH_SERVICE_ACCOUNT_JSON is set,
    otherwise falls back to default app.
    """
    import firebase_admin

    configured, _ = ensure_firebase_auth_admin()
    if not configured:
        return None

    if _load_service_account_from_env(AUTH_SERVICE_ACCOUNT_ENV):
        try:
            return firebase_admin.get_app(AUTH_APP_NAME)
        except ValueError:
            return None

    try:
        return firebase_admin.get_app()
    except ValueError:
        return None
