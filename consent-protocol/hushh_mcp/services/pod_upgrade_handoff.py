"""Authenticated hub-to-pod controls for an owner-approved image update.

The hub already invokes private pods with a Google identity token.  This module
uses that same identity and the pod's asserted HusshID to fence work before a
Cloud Run replacement.  It deliberately carries only an operation id and the
current deployment incarnation; no owner information or credentials cross the
wire.
"""

from __future__ import annotations

import time
from typing import Any, Optional


class PodUpgradeHandoffUnavailable(RuntimeError):
    """The pod could not authenticate or complete the lifecycle handoff."""


def service_incarnation(service: Optional[dict[str, Any]]) -> Optional[str]:
    """Return the serving revision used by the pod's own incarnation guard."""
    status = (service or {}).get("status") if isinstance(service, dict) else None
    revision = status.get("latestReadyRevisionName") if isinstance(status, dict) else None
    if isinstance(revision, str) and revision.strip():
        return revision.strip()[:256]
    # Test and older API responses may expose the revision under traffic only.
    traffic = status.get("traffic") if isinstance(status, dict) else None
    if isinstance(traffic, list) and len(traffic) == 1 and isinstance(traffic[0], dict):
        revision = traffic[0].get("revisionName")
        if isinstance(revision, str) and revision.strip():
            return revision.strip()[:256]
    return None


class PodUpgradeHandoffClient:
    """Small synchronous client; callers run it off the event loop."""

    def __init__(self, *, url: str, hushh_id: str, session: Any = None) -> None:
        value = str(url or "").strip().rstrip("/")
        if not value.startswith("https://"):
            raise PodUpgradeHandoffUnavailable("pod lifecycle endpoint is not HTTPS")
        if not str(hushh_id or "").strip():
            raise PodUpgradeHandoffUnavailable("pod identity is unavailable")
        self._url = value
        self._hushh_id = str(hushh_id).strip()[:256]
        self._session = session

    def _request(
        self, method: str, path: str, *, body: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        import requests  # type: ignore[import-untyped]

        client = self._session or requests
        try:
            import google.auth.transport.requests as google_requests  # type: ignore[import-untyped]
            import google.oauth2.id_token as google_id_token  # type: ignore[import-untyped]

            token = google_id_token.fetch_id_token(google_requests.Request(), self._url)
        except Exception as exc:  # noqa: BLE001 - identity failure is a hard handoff failure
            raise PodUpgradeHandoffUnavailable(
                f"pod lifecycle identity unavailable: {type(exc).__name__}"
            ) from exc
        headers = {
            "Authorization": f"Bearer {token}",
            "X-Hushh-Pod-Id": self._hushh_id,
            "Content-Type": "application/json",
        }
        try:
            response = getattr(client, method.lower())(
                f"{self._url}{path}",
                **({"json": body} if body is not None else {}),
                headers=headers,
                timeout=15,
                allow_redirects=False,
            )
        except Exception as exc:  # noqa: BLE001 - the pod may be cold or unavailable
            raise PodUpgradeHandoffUnavailable(
                f"pod lifecycle request unavailable: {type(exc).__name__}"
            ) from exc
        status = int(getattr(response, "status_code", 0) or 0)
        if status != 200:
            raise PodUpgradeHandoffUnavailable(f"pod lifecycle refused: HTTP {status}")
        try:
            value = response.json()
        except Exception as exc:  # noqa: BLE001 - malformed lifecycle evidence is unsafe
            raise PodUpgradeHandoffUnavailable("pod lifecycle response was not JSON") from exc
        if not isinstance(value, dict):
            raise PodUpgradeHandoffUnavailable("pod lifecycle response was invalid")
        return value

    def prepare_and_wait(
        self,
        *,
        operation_id: str,
        incarnation: str,
        timeout_seconds: float = 300.0,
        poll_seconds: float = 1.0,
    ) -> dict[str, Any]:
        """Fence work, then return the authoritative idle receipt."""
        payload = {
            "operationId": str(operation_id).strip(),
            "incarnation": str(incarnation).strip(),
        }
        self._request("POST", "/api/one/pod/upgrade/prepare", body=payload)
        deadline = time.monotonic() + max(1.0, float(timeout_seconds))
        while True:
            status = self._request("GET", "/api/one/pod/upgrade/status")
            if (
                status.get("state") == "idle"
                and status.get("operationId") == payload["operationId"]
                and status.get("incarnation") == payload["incarnation"]
                and isinstance(status.get("idleReceipt"), dict)
            ):
                return status["idleReceipt"]
            if time.monotonic() >= deadline:
                raise PodUpgradeHandoffUnavailable("pod did not produce an idle receipt in time")
            time.sleep(max(0.05, min(float(poll_seconds), deadline - time.monotonic())))

    def release(self, *, operation_id: str, incarnation: str) -> dict[str, Any]:
        """Release a fence only when replacement was not submitted or failed definitively."""
        return self._request(
            "POST",
            "/api/one/pod/upgrade/release",
            body={
                "operationId": str(operation_id).strip(),
                "incarnation": str(incarnation).strip(),
            },
        )


__all__ = [
    "PodUpgradeHandoffClient",
    "PodUpgradeHandoffUnavailable",
    "service_incarnation",
]
