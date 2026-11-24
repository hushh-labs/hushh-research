"""Read-only Cloud Run transport and readiness projection helpers."""

from __future__ import annotations

import logging
import re
import time
from typing import Any, Callable, Optional

from hushh_mcp.services import gcp_run_terminal_observation as terminal_observation

logger = logging.getLogger("hushh_mcp.services.gcp_run_client")

ServiceReader = Callable[[str], Optional[dict[str, Any]]]
ServiceUidValidator = Callable[[Optional[dict[str, Any]], str], None]
CurrentStatusValidator = Callable[[Optional[dict[str, Any]]], bool]


def get_service(*, base_url: str, name: str, headers: dict[str, str]) -> Optional[dict[str, Any]]:
    import requests  # type: ignore[import-untyped]

    response = requests.get(
        f"{base_url}/services/{name}",
        headers=headers,
        timeout=30,
        allow_redirects=False,
    )
    if response.status_code == 404:
        return None
    response.raise_for_status()
    if response.status_code != 200:
        raise RuntimeError("Cloud Run service observation not confirmed")
    return dict(response.json())


def v2_service_resource(project: str, region: str, name: str) -> str:
    if re.fullmatch(r"[a-z][a-z0-9-]{0,48}", name or "") is None:
        raise RuntimeError("Cloud Run v2 service name is unverified")
    return f"projects/{project}/locations/{region}/services/{name}"


def get_v2_service(*, resource: str, headers: dict[str, str]) -> dict[str, Any]:
    """Read the same regional service through the v2 status contract."""
    import requests  # type: ignore[import-untyped]

    response = requests.get(
        f"https://run.googleapis.com/v2/{resource}",
        headers=headers,
        timeout=30,
        allow_redirects=False,
    )
    response.raise_for_status()
    if response.status_code != 200:
        raise RuntimeError("Cloud Run v2 service readback not confirmed")
    value = response.json()
    if not isinstance(value, dict):
        raise RuntimeError("Cloud Run v2 service readback is invalid")
    return value


def get_v2_revision(
    *, service_resource: str, revision_name: str, headers: dict[str, str]
) -> dict[str, Any]:
    """Read only the revision named by that exact v2 service observation."""
    import requests  # type: ignore[import-untyped]

    prefix = f"{service_resource}/revisions/"
    if (
        not isinstance(revision_name, str)
        or not revision_name.startswith(prefix)
        or re.fullmatch(r"[a-z][a-z0-9-]{0,62}", revision_name.removeprefix(prefix)) is None
    ):
        raise RuntimeError("Cloud Run v2 revision name is unverified")
    response = requests.get(
        f"https://run.googleapis.com/v2/{revision_name}",
        headers=headers,
        timeout=30,
        allow_redirects=False,
    )
    response.raise_for_status()
    if response.status_code != 200:
        raise RuntimeError("Cloud Run v2 revision readback not confirmed")
    value = response.json()
    if not isinstance(value, dict):
        raise RuntimeError("Cloud Run v2 revision readback is invalid")
    return value


def status_is_current(service: Optional[dict[str, Any]]) -> bool:
    """Whether Knative observed the desired metadata generation."""
    desired = ((service or {}).get("metadata") or {}).get("generation")
    if not isinstance(desired, int):
        return True
    observed = ((service or {}).get("status") or {}).get("observedGeneration")
    return isinstance(observed, int) and observed >= desired


def ready_failure(service: Optional[dict[str, Any]]) -> Optional[str]:
    conditions = ((service or {}).get("status") or {}).get("conditions") or []
    ready = next((condition for condition in conditions if condition.get("type") == "Ready"), None)
    if ready and ready.get("status") == "False":
        return str(ready.get("message") or "startup failed")
    return None


def service_url(service: Optional[dict[str, Any]]) -> Optional[str]:
    return ((service or {}).get("status") or {}).get("url")


def wait_ready(
    get: ServiceReader,
    require_uid: ServiceUidValidator,
    is_current: CurrentStatusValidator,
    name: str,
    *,
    timeout_s: float = 150.0,
    interval_s: float = 3.0,
    expected_uid: Optional[str] = None,
    expected_revision_nonce: Optional[str] = None,
    expected_generation: Optional[int] = None,
) -> tuple[bool, Optional[dict[str, Any]]]:
    """Poll until Ready resolves or timeout elapses, ignoring stale generations.

    ``metadata.generation`` is the desired state; ``status.observedGeneration`` is
    how far the controller has reconciled. Until they meet, the Ready condition can
    still describe the previous revision. The client callbacks preserve the owning
    GcpRunClient's request/authentication path and incarnation validation.
    """
    deadline = time.monotonic() + timeout_s
    last: Optional[dict[str, Any]] = None
    while time.monotonic() < deadline:
        service = get(name)
        if expected_uid is not None:
            require_uid(service, expected_uid)
        if expected_revision_nonce is not None:
            metadata = (((service or {}).get("spec") or {}).get("template") or {}).get(
                "metadata"
            ) or {}
            actual_nonce = (metadata.get("annotations") or {}).get("hussh/restart-nonce")
            if actual_nonce != expected_revision_nonce:
                raise RuntimeError("Cloud Run upgrade attempt changed or unverified")
            generation = ((service or {}).get("metadata") or {}).get("generation")
            if not isinstance(generation, int) or isinstance(generation, bool) or generation < 1:
                raise RuntimeError("Cloud Run upgrade generation unverified")
        if expected_generation is not None and (
            ((service or {}).get("metadata") or {}).get("generation") != expected_generation
        ):
            raise RuntimeError("Cloud Run acknowledged generation changed")
        last = service
        if not is_current(service):
            time.sleep(interval_s)
            continue
        conditions = ((service or {}).get("status") or {}).get("conditions") or []
        ready = next(
            (condition for condition in conditions if condition.get("type") == "Ready"), None
        )
        if ready and ready.get("status") == "True":
            return True, service
        if ready and ready.get("status") == "False":
            logger.warning("gcp_run.not_ready name=%s reason=%s", name, ready.get("message"))
            return False, service
        time.sleep(interval_s)
    return False, last


def observe_upgrade_acknowledgement(
    service: Optional[dict[str, Any]],
    receipt: dict[str, Any],
    *,
    name: str,
    expected_uid: str,
    attempt_id: str,
    is_current: CurrentStatusValidator,
) -> tuple[Optional[bool], dict[str, Any]]:
    if receipt.get("version") != 1 or receipt.get("service") != name:
        raise RuntimeError("Cloud Run upgrade receipt binding invalid")
    if service is None:
        raise RuntimeError("Cloud Run acknowledged service unavailable")
    actual = terminal_observation.upgrade_acknowledgement(
        service, name=name, expected_uid=expected_uid, attempt_id=attempt_id
    )
    if any(receipt.get(key) != value for key, value in actual.items()):
        raise RuntimeError("Cloud Run acknowledged replacement changed")
    if not is_current(service):
        return None, service
    condition: dict[str, Any] = next(
        (
            item
            for item in (service.get("status") or {}).get("conditions", [])
            if item.get("type") == "Ready"
        ),
        {},
    )
    ready = condition.get("status")
    if not isinstance(ready, str):
        return None, service
    return {"True": True, "False": False}.get(ready), service
