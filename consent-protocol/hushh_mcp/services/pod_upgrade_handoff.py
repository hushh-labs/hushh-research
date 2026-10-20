"""Authenticated hub-to-pod controls for an owner-approved image update.

The hub already invokes private pods with a Google identity token.  This module
uses that same identity and the pod's asserted HusshID to fence work before a
Cloud Run replacement.  It deliberately carries only an operation id and the
current deployment incarnation; no owner information or credentials cross the
wire.
"""

from __future__ import annotations

import hashlib
import re
import time
from copy import deepcopy
from typing import Any, Callable, Optional
from urllib.parse import urlencode

from hushh_mcp.services.compute_backend import PodSpec


class PodUpgradeHandoffUnavailable(RuntimeError):
    """The pod could not authenticate or complete the lifecycle handoff."""


def retained_idle_evidence(
    receipt: dict[str, Any], *, operation_id: str, require_cursor: bool = False
) -> dict[str, Any]:
    """Retain authenticated handoff metadata, never invent a durable cursor.

    Older runtimes omit cursors. Their image-only flow remains compatible;
    VM replacement requires both the committed prefix and its later idle marker.
    The caller still owns authenticated dispatch and lease-bound publication.
    """
    if (
        not operation_id
        or receipt.get("operationId") != operation_id
        or type(receipt.get("activeWork")) is not int
        or receipt["activeWork"] != 0
        or not isinstance(receipt.get("incarnation"), str)
        or not 1 <= len(receipt["incarnation"]) <= 256
        or not isinstance(receipt.get("committedState"), str)
        or not isinstance(receipt.get("runtimeEpoch"), str)
        or not 1 <= len(receipt["runtimeEpoch"]) <= 256
    ):
        raise PodUpgradeHandoffUnavailable("upgrade handoff idle receipt invalid")
    prefix, marker = receipt.get("committedCursor"), receipt.get("idleRecord")
    if prefix is None and marker is None and not require_cursor:
        return {"handoffIncarnation": receipt["incarnation"]}
    if not isinstance(prefix, dict) or not isinstance(marker, dict):
        raise PodUpgradeHandoffUnavailable("upgrade handoff durable cursor invalid")
    for cursor in (prefix, marker):
        if (
            set(cursor) != {"seq", "sha"}
            or type(cursor.get("seq")) is not int
            or cursor["seq"] < 1
            or not isinstance(cursor.get("sha"), str)
            or re.fullmatch(r"[a-f0-9]{64}", cursor["sha"]) is None
        ):
            raise PodUpgradeHandoffUnavailable("upgrade handoff durable cursor invalid")
    expected = hashlib.sha256(
        f"{operation_id}|{receipt['incarnation']}|{prefix['seq']}|{prefix['sha']}|active=0".encode()
    ).hexdigest()
    if marker["seq"] <= prefix["seq"] or receipt["committedState"] != expected:
        raise PodUpgradeHandoffUnavailable("upgrade handoff committed state changed")
    return {
        "handoffIncarnation": receipt["incarnation"],
        "handoffRuntimeEpoch": receipt["runtimeEpoch"],
        "handoffCommittedState": expected,
        "handoffCommittedCursor": deepcopy(prefix),
        "handoffIdleRecord": deepcopy(marker),
    }


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

    def __init__(
        self,
        *,
        url: str,
        hushh_id: str,
        session: Any = None,
        identity_token_provider: Callable[[str], str] | None = None,
        request_budget: Callable[[], float] | None = None,
    ) -> None:
        value = str(url or "").strip().rstrip("/")
        if not value.startswith("https://"):
            raise PodUpgradeHandoffUnavailable("pod lifecycle endpoint is not HTTPS")
        if not str(hushh_id or "").strip():
            raise PodUpgradeHandoffUnavailable("pod identity is unavailable")
        self._url = value
        self._hushh_id = str(hushh_id).strip()[:256]
        self._session = session
        self._identity_token_provider = identity_token_provider
        self._request_budget = request_budget

    def _request(
        self, method: str, path: str, *, body: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        import requests  # type: ignore[import-untyped]

        client = self._session or requests
        budget = min(60.0, self._request_budget()) if self._request_budget else 60.0
        if budget <= 0:
            raise PodUpgradeHandoffUnavailable("pod lifecycle deadline exceeded")
        try:
            import google.auth.transport.requests as google_requests  # type: ignore[import-untyped]
            import google.oauth2.id_token as google_id_token  # type: ignore[import-untyped]

            token = (
                self._identity_token_provider(self._url)
                if self._identity_token_provider
                else google_id_token.fetch_id_token(google_requests.Request(), self._url)
            )
        except Exception as exc:  # noqa: BLE001 - identity failure is a hard handoff failure
            raise PodUpgradeHandoffUnavailable(
                f"pod lifecycle identity unavailable: {type(exc).__name__}"
            ) from exc
        headers = {
            "Authorization": f"Bearer {token}",
            "X-Hushh-Pod-Id": self._hushh_id,
            "Content-Type": "application/json",
        }
        # Token acquisition may block. Recheck cancellation and authority at the
        # actual dispatch boundary, rather than submitting with an earlier grant.
        budget = min(60.0, self._request_budget()) if self._request_budget else 60.0
        if budget <= 0:
            raise PodUpgradeHandoffUnavailable("pod lifecycle deadline exceeded")
        try:
            response = getattr(client, method.lower())(
                f"{self._url}{path}",
                **({"json": body} if body is not None else {}),
                headers=headers,
                # The owner's scale-to-zero pod can take over 35 seconds to
                # start. Keep connection setup bounded while allowing startup.
                timeout=(min(10.0, budget), budget),
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
        timeout_seconds: float | None = None,
        poll_seconds: float = 1.0,
        guard: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        """Fence work, then return the authoritative idle receipt."""
        payload = {
            "operationId": str(operation_id).strip(),
            "incarnation": str(incarnation).strip(),
        }
        if guard is not None:
            guard()
        self._request("POST", "/api/one/pod/upgrade/prepare", body=payload)
        deadline = (
            time.monotonic() + max(1.0, float(timeout_seconds))
            if timeout_seconds is not None
            else None
        )
        while True:
            if guard is not None:
                guard()
            status = self._request("GET", "/api/one/pod/upgrade/status")
            receipt = status.get("idleReceipt")
            if (
                status.get("state") == "idle"
                and status.get("operationId") == payload["operationId"]
                and status.get("incarnation") == payload["incarnation"]
                and isinstance(receipt, dict)
                and receipt.get("operationId") == payload["operationId"]
                and receipt.get("incarnation") == payload["incarnation"]
                and receipt.get("activeWork") == 0
                and isinstance(receipt.get("committedState"), str)
                and receipt.get("runtimeEpoch")
            ):
                return receipt
            if deadline is not None and time.monotonic() >= deadline:
                raise PodUpgradeHandoffUnavailable("pod did not produce an idle receipt in time")
            interval = max(0.05, float(poll_seconds))
            if deadline is not None:
                interval = min(interval, max(0.05, deadline - time.monotonic()))
            time.sleep(interval)

    def release(
        self,
        *,
        operation_id: str,
        incarnation: str,
        expected_idle_record: dict[str, Any] | None = None,
        guard: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        """Release a reconciled fence, or a verified VM recovery's exact idle cursor.

        VM callers verify identity, image and encrypted recovery before release;
        provider power state is insufficient. The optional cursor is compared
        atomically by the pod. Existing failed-image handoffs retain their contract.
        """
        if guard is not None:
            guard()
        return self._request(
            "POST",
            "/api/one/pod/upgrade/release",
            body={
                "operationId": str(operation_id).strip(),
                "incarnation": str(incarnation).strip(),
                **(
                    {"expectedIdleRecord": expected_idle_record}
                    if expected_idle_record is not None
                    else {}
                ),
            },
        )

    def verify_model(self, *, deployment: str, expected_revision: str) -> dict[str, Any]:
        """Existing machine-authenticated routes; no owner information is submitted."""
        info = self._request("GET", "/pod/info")
        if (
            info.get("hushhId") != self._hushh_id
            or info.get("revision") != expected_revision
            or info.get("podMode") is not True
            or info.get("memoryEnabled") is not True
            or info.get("storageBackend") != "commit_log"
        ):
            raise PodUpgradeHandoffUnavailable("model repair runtime recovery is unverified")
        result = self._request("GET", "/pod/diagnostics/model?" + urlencode({"model": deployment}))
        if (
            result.get("provider") != "azure_openai"
            or result.get("model") != deployment
            or result.get("reachable") is not True
            or result.get("status") != 200
            or result.get("outcome") != "reachable"
        ):
            raise PodUpgradeHandoffUnavailable(
                "model repair managed-identity inference is unverified"
            )
        return {
            "provider": "azure_openai",
            "model": deployment,
            "endpoint": result.get("endpoint"),
            "revision": expected_revision,
            "reachable": True,
        }

    def recovery_snapshot(self) -> dict[str, dict[str, Any]]:
        """Authenticated runtime, public keys and sealed lifecycle projection."""
        return {
            "info": self._request("GET", "/pod/info"),
            "keys": self._request("GET", "/pod/public-key"),
            "status": self._request("GET", "/api/one/pod/upgrade/status"),
        }

    def verify_maintenance_access(
        self, *, expected_revision: str, operation_id: str | None
    ) -> None:
        """Prove existing authenticated maintenance admission before resource writes."""
        info = self._request("GET", "/pod/info")
        status = self._request("GET", "/api/one/pod/upgrade/status")
        if (
            info.get("hushhId") != self._hushh_id
            or info.get("revision") != expected_revision
            or info.get("podMode") is not True
            or status.get("incarnation") != expected_revision
            or status.get("state") not in {"accepting", "draining", "idle"}
            or not status.get("runtimeEpoch")
            or (status.get("state") != "accepting" and status.get("operationId") != operation_id)
        ):
            raise PodUpgradeHandoffUnavailable("model repair maintenance admission is unverified")


__all__ = [
    "PodUpgradeHandoffClient",
    "PodUpgradeHandoffUnavailable",
    "retained_idle_evidence",
    "service_incarnation",
]


def prepare_managed_upgrade_handoff(
    spec: PodSpec, existing: dict[str, Any]
) -> tuple[PodUpgradeHandoffClient | None, str | None]:
    """Drain an existing managed runtime through its already approved operation."""
    if not spec.upgrade_operation_id:
        return None, None
    from hushh_mcp.services.gcp_run_client import GcpRunClient

    pod_url = GcpRunClient.service_url(existing)
    incarnation = service_incarnation(existing)
    if not pod_url or not incarnation:
        raise RuntimeError("pod upgrade handoff capability is unavailable")
    handoff = PodUpgradeHandoffClient(url=pod_url, hushh_id=spec.hushh_id)
    try:
        handoff.prepare_and_wait(operation_id=spec.upgrade_operation_id, incarnation=incarnation)
    except Exception:
        try:
            handoff.release(operation_id=spec.upgrade_operation_id, incarnation=incarnation)
        except Exception:
            import logging

            logging.getLogger("hushh_mcp.services.gcp_backend").info(
                "gcp_backend.handoff_release_after_prepare_failed",
                exc_info=True,
            )
        raise
    return handoff, incarnation
