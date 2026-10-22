"""Read-only GCP update recovery behind the existing compute backend methods."""

from __future__ import annotations

import asyncio
from typing import Any

from hushh_mcp.services.compute_backend import BackendHandle, PodSpec
from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.pod_connector_configuration import (
    require_gcp_connector_configuration,
    validate_connector_environment,
)


async def _observe(client: Any, name: str, spec: PodSpec, receipt: dict[str, Any]):
    if not spec.expected_service_uid or not spec.upgrade_attempt_id:
        raise RuntimeError("upgrade recovery authority unavailable")
    expectation = (
        validate_connector_environment(receipt["connectorEnvironment"])
        if "connectorEnvironment" in receipt
        else None
    )
    ready, service = await asyncio.to_thread(
        client.observe_upgrade_acknowledgement,
        receipt,
        name=name,
        expected_uid=spec.expected_service_uid,
        attempt_id=spec.upgrade_attempt_id,
    )
    if ready and expectation is not None:
        require_gcp_connector_configuration(service, expectation)
    return ready, service


async def inspect_user_configuration(backend: Any, spec: PodSpec, *, name: str) -> dict:
    """Read the existing service under its recorded identity; never mutate it."""
    if not backend.live or not spec.expected_service_uid:
        raise ValueError("Configuration inspection requires a live, verified pod incarnation")
    client = await asyncio.to_thread(backend._client)
    service = await asyncio.to_thread(client.get_service, name)
    if not isinstance(service, dict):
        raise ValueError("The existing pod service is unavailable")
    GcpRunClient.require_service_uid(service, spec.expected_service_uid)
    return service


def verified_capabilities(spec: PodSpec, service: dict) -> dict[str, Any]:
    """Verify installed configuration once for replacement and recovery callers."""
    capability_metadata: dict[str, Any] = {}
    if spec.files_upgrade_plan is not None:
        from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan

        plan = FilesCapabilityPlan.model_validate(spec.files_upgrade_plan)
        plan.require_installed(service)
        capability_metadata = {"filesCapability": {"planDigest": plan.digest, "status": "enabled"}}
    if spec.browser_upgrade_plan is not None:
        import json

        from hushh_mcp.services.pod_browser.capability_update import GcpBrowserCapabilityPlan

        browser = GcpBrowserCapabilityPlan.model_validate_json(
            json.dumps(spec.browser_upgrade_plan)
        )
        browser.require_installed(service)
        capability_metadata.update(
            browserCapability={"planDigest": browser.digest, "status": "configured"}
        )
    return capability_metadata


async def observe_user_upgrade(
    client: Any, *, name: str, route: str, backend_id: str, spec: PodSpec, receipt: dict[str, Any]
) -> BackendHandle | None:
    ready, service = await _observe(client, name, spec, receipt)
    if ready is None:
        return None
    image = receipt["image"]
    digest = image.rsplit("@", 1)[-1] if "@" in image else None
    if not digest or not digest.startswith("sha256:"):
        raise RuntimeError("upgrade recovery image unverified")
    capability_metadata = verified_capabilities(spec, service) if ready else {}
    return BackendHandle(
        external_agent_id=name,
        a2a_route=route,
        status="live" if ready else "failed",
        backend=backend_id,
        backend_metadata={
            "image": image,
            "image_digest": digest,
            "source_image": receipt["targetImage"],
            "url": GcpRunClient.service_url(service) or "",
            **capability_metadata,
        },
    )


async def observe_hosted_upgrade(
    client: Any, *, name: str, route: str, backend_id: str, spec: PodSpec, receipt: dict[str, Any]
) -> BackendHandle | None:
    ready, service = await _observe(client, name, spec, receipt)
    if ready is None:
        return None
    return BackendHandle(
        external_agent_id=name,
        a2a_route=route,
        status="live" if ready else "failed",
        backend=backend_id,
        backend_metadata={
            "image": receipt["image"],
            "url": GcpRunClient.service_url(service) or "",
        },
    )
