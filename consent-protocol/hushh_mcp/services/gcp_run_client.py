"""Minimal Cloud Run Admin (v1 knative) REST client for the GCP compute backend.

Used ONLY in live mode by ``GcpBackend`` to actually create / get / delete a
per-user Cloud Run service. The token is minted from the operator service account
(``GCP_DEPLOY_SA_KEY_B64``); every call goes through the agent proxy + CA bundle
the environment configures (honored automatically by requests via the proxy env).

Sync + requests-based (google-auth's transport is requests); ``GcpBackend`` calls
it off the event loop via ``asyncio.to_thread``. The v1 knative API is used because
its Service body is exactly what ``GcpBackend.render_deploy_config`` already emits.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

_SA_KEY_ENV = "GCP_DEPLOY_SA_KEY_B64"
_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def load_operator_credentials(sa_key_b64: Optional[str] = None) -> Any:
    """Load scoped SA credentials from the base64 SA-key env (or an override)."""
    from google.oauth2 import service_account

    raw = sa_key_b64 if sa_key_b64 is not None else os.getenv(_SA_KEY_ENV, "")
    if not raw:
        raise RuntimeError(f"{_SA_KEY_ENV} is not set; GcpBackend live mode needs credentials")
    info = json.loads(base64.b64decode(raw))
    return service_account.Credentials.from_service_account_info(info, scopes=_SCOPES)


class GcpRunClient:
    """Create / get / delete Cloud Run services via the v1 knative regional API."""

    def __init__(self, *, project: str, region: str, credentials: Any = None) -> None:
        if not project:
            raise RuntimeError("GcpRunClient requires a project")
        self._project = project
        self._region = region
        self._creds = credentials if credentials is not None else load_operator_credentials()
        self._base = (
            f"https://{region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/{project}"
        )

    def _headers(self) -> dict[str, str]:
        import google.auth.transport.requests as gtr

        if not getattr(self._creds, "valid", False):
            self._creds.refresh(gtr.Request())
        return {
            "Authorization": f"Bearer {self._creds.token}",
            "Content-Type": "application/json",
        }

    def create_service(self, body: dict[str, Any]) -> dict[str, Any]:
        import requests  # type: ignore[import-untyped]

        r = requests.post(f"{self._base}/services", headers=self._headers(), json=body, timeout=60)
        r.raise_for_status()
        return dict(r.json())

    def get_service(self, name: str) -> Optional[dict[str, Any]]:
        import requests  # type: ignore[import-untyped]

        r = requests.get(f"{self._base}/services/{name}", headers=self._headers(), timeout=30)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return dict(r.json())

    def delete_service(self, name: str) -> None:
        import requests  # type: ignore[import-untyped]

        r = requests.delete(f"{self._base}/services/{name}", headers=self._headers(), timeout=60)
        # Idempotent teardown: an already-gone service is success.
        if r.status_code not in (200, 404):
            r.raise_for_status()

    def wait_ready(
        self, name: str, *, timeout_s: float = 150.0, interval_s: float = 3.0
    ) -> tuple[bool, Optional[dict[str, Any]]]:
        """Poll until the service's Ready condition is True (ok) or False (failed),
        or the timeout elapses. Returns (ready, last_service_json)."""
        deadline = time.monotonic() + timeout_s
        last: Optional[dict[str, Any]] = None
        while time.monotonic() < deadline:
            svc = self.get_service(name)
            last = svc
            conditions = ((svc or {}).get("status") or {}).get("conditions") or []
            ready = next((c for c in conditions if c.get("type") == "Ready"), None)
            if ready and ready.get("status") == "True":
                return True, svc
            if ready and ready.get("status") == "False":
                logger.warning("gcp_run.not_ready name=%s reason=%s", name, ready.get("message"))
                return False, svc
            time.sleep(interval_s)
        return False, last

    @staticmethod
    def service_url(svc: Optional[dict[str, Any]]) -> Optional[str]:
        return ((svc or {}).get("status") or {}).get("url")
