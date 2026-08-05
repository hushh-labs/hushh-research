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

    @staticmethod
    def merge_for_replace(
        current: dict[str, Any],
        desired: dict[str, Any],
        *,
        revision_nonce: Optional[str] = None,
    ) -> dict[str, Any]:
        """Build the PUT body for an in-place replace. Pure -- no I/O, so it is tested.

        Three things have to be true at once and none of them are automatic:

        1. **System-managed metadata survives.** The live object carries fields the
           caller's rendered config has never heard of (``uid``, ``creationTimestamp``,
           ``serving.knative.dev/creator``, operation ids). ``replaceService`` only
           permits ``spec`` plus metadata labels/annotations to change, so the body is
           built by overlaying the desired spec onto the LIVE object rather than
           posting the rendered config as if it were whole.

        2. **``resourceVersion`` is carried forward.** That is what makes the PUT an
           optimistic-concurrency update: if anything else wrote to the service since
           the read, the API rejects this instead of silently clobbering it.

        3. **The revision template genuinely differs.** Cloud Run mints a new revision
           only when the template changes. A heal that replays the identical template
           is accepted, changes nothing, and restarts NOTHING -- the container keeps
           running with whatever broke it, while the caller logs a successful heal.
           ``revision_nonce`` stamps the template so the new revision is real, and it
           doubles as a durable record of when this pod was last healed.
        """
        merged = dict(current)
        merged["spec"] = desired.get("spec") or {}

        current_meta = dict(current.get("metadata") or {})
        desired_meta = dict(desired.get("metadata") or {})
        # Labels and annotations are the only metadata the API lets us modify; take
        # the desired values but keep any the live object has that we do not render,
        # so a replace never strips a field someone else set.
        for key in ("labels", "annotations"):
            if desired_meta.get(key):
                current_meta[key] = {**(current_meta.get(key) or {}), **desired_meta[key]}
        merged["metadata"] = current_meta

        if revision_nonce:
            template = dict(merged["spec"].get("template") or {})
            template_meta = dict(template.get("metadata") or {})
            template_meta["annotations"] = {
                **(template_meta.get("annotations") or {}),
                "hussh/restart-nonce": revision_nonce,
            }
            template["metadata"] = template_meta
            merged["spec"] = {**merged["spec"], "template": template}

        # `status` is server-owned; sending a stale copy back is at best ignored and
        # at worst rejected.
        merged.pop("status", None)
        return merged

    def replace_service(
        self,
        name: str,
        body: dict[str, Any],
        *,
        revision_nonce: Optional[str] = None,
    ) -> dict[str, Any]:
        """Replace a live service in place (PUT), rolling it onto a fresh revision.

        This is the RESTART primitive, and it is deliberately not ``delete`` +
        ``create``. Deleting a Cloud Run service drops its URL, and the hub has that
        URL recorded; a restart that changes the address is not a restart, it is a
        migration the owner never asked for. A PUT keeps the service, its name, and
        its URL, and swaps only the revision underneath.

        Raises if the service does not exist. A replace is not a create -- conflating
        the two is how "restart my agent" quietly becomes "provision a new one",
        which is a different act with different consequences for the caller.
        """
        import requests  # type: ignore[import-untyped]

        current = self.get_service(name)
        if current is None:
            raise RuntimeError(f"cannot replace {name}: no such Cloud Run service")

        merged = self.merge_for_replace(current, body, revision_nonce=revision_nonce)
        r = requests.put(
            f"{self._base}/services/{name}", headers=self._headers(), json=merged, timeout=60
        )
        r.raise_for_status()
        logger.info("gcp_run.replaced name=%s nonce_present=%s", name, bool(revision_nonce))
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
