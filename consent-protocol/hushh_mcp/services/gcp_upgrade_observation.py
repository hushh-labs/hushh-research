"""Read-only GCP update recovery behind the existing compute backend methods."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Optional, Protocol

from hushh_mcp.services.compute_backend import BackendHandle, PodSpec
from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.pod_connector_configuration import (
    require_gcp_connector_configuration,
    validate_connector_environment,
)


class _UpgradeHandoff(Protocol):
    def release(self, *, operation_id: str, incarnation: str) -> Any: ...


def deployed_image_digest(service: dict[str, Any] | None) -> str | None:
    """Return the digest pinned by a service template, when one is present."""
    if not service:
        return None
    try:
        image = str(service["spec"]["template"]["spec"]["containers"][0].get("image", ""))
    except (KeyError, IndexError, TypeError):
        return None
    return image.rsplit("@", 1)[-1] if "@sha256:" in image else None


def bind_gcp_upgrade_acknowledgement(
    acknowledged: dict[str, Any],
    *,
    name: str,
    expected_uid: str,
    attempt_id: str,
    connector_environment: dict[str, Any],
    predecessor: dict[str, Any],
    target_image: str,
    target_digest: str | None,
) -> dict[str, Any]:
    """Bind the exact Cloud Run acknowledgement to the approved GCP image."""
    from hushh_mcp.services.pod_release import image_digest

    receipt = GcpRunClient.upgrade_acknowledgement(
        acknowledged,
        name=name,
        expected_uid=expected_uid,
        attempt_id=attempt_id,
    )
    if connector_environment:
        receipt["connectorEnvironment"] = connector_environment
    receipt["predecessor"] = predecessor
    deployed_image = receipt["image"]
    if image_digest(deployed_image) != target_digest:
        raise RuntimeError("Cloud Run acknowledgement differs from the approved image")
    receipt.update(
        sourceImage=target_image,
        sourceDigest=target_digest,
        targetImage=target_image,
        targetDigest=target_digest,
        deployedImage=deployed_image,
    )
    return receipt


def bind_user_gcp_upgrade_acknowledgement(
    acknowledged: dict[str, Any],
    *,
    name: str,
    expected_uid: str,
    attempt_id: str,
    connector_environment: dict[str, Any],
    predecessor: dict[str, Any] | None,
    source_image: str | None,
    source_digest: str,
    recorded_digest: str | None,
    deployed_image: str,
) -> dict[str, Any]:
    """Bind an owner-project acknowledgement to the exact copied image receipt."""
    receipt = GcpRunClient.upgrade_acknowledgement(
        acknowledged,
        name=name,
        expected_uid=expected_uid,
        attempt_id=attempt_id,
    )
    if connector_environment:
        receipt["connectorEnvironment"] = connector_environment
    if predecessor is not None:
        receipt["predecessor"] = predecessor
    if receipt["image"] != deployed_image:
        raise RuntimeError("Cloud Run acknowledgement differs from the copied image")
    receipt.update(
        sourceImage=source_image,
        sourceDigest=source_digest,
        targetImage=source_image,
        targetDigest=recorded_digest or source_digest,
        deployedImage=deployed_image,
    )
    return receipt


def observe_terminal_failure(
    client: Any,
    *,
    name: str,
    expected_uid: str,
    target_image: str,
    deployed_image: str,
    attempt_id: str,
    expected_generation: int,
    predecessor: dict[str, Any],
) -> dict[str, Any]:
    """Use the client's one exact read-only terminal proof path."""
    return client.observe_hosted_files_terminal_failure(
        name=name,
        expected_uid=expected_uid,
        target_image=target_image,
        deployed_image=deployed_image,
        attempt_id=attempt_id,
        expected_generation=expected_generation,
        predecessor=predecessor,
    )


def settle_failed_gcp_upgrade(
    client: Any,
    *,
    name: str,
    expected_uid: str,
    target_image: str,
    service: Optional[dict[str, Any]],
    previous: Optional[str],
    acknowledgement: dict[str, Any] | None,
    acknowledge: Optional[Callable[[dict[str, Any]], Any]],
    predecessor: dict[str, Any],
    attempt_id: str,
    handoff: _UpgradeHandoff | None,
    handoff_incarnation: str | None,
    operation_id: str,
) -> tuple[bool, Optional[dict[str, Any]], Optional[str], dict[str, Any]]:
    """Settle one current terminal failure in the existing provider worker."""
    if GcpRunClient.ready_failure(service) is None:
        raise RuntimeError(
            f"upgrade of {name} to {target_image} was not confirmed Ready in time; "
            "provider settlement remains unknown"
        )
    if acknowledgement is None or acknowledge is None:
        raise RuntimeError("Cloud Run failed update has no retained acknowledgement")
    if acknowledgement.get("deployedImage") != target_image:
        raise RuntimeError("Cloud Run acknowledged image differs from the managed target")
    terminal_failure = observe_terminal_failure(
        client,
        name=name,
        expected_uid=expected_uid,
        target_image=target_image,
        deployed_image=acknowledgement["deployedImage"],
        attempt_id=attempt_id,
        expected_generation=acknowledgement["generation"],
        predecessor=predecessor,
    )
    acknowledge(
        {
            **acknowledgement,
            "outcome": "failed",
            "ready": False,
            "observedGeneration": terminal_failure["observedGeneration"],
            "revision": terminal_failure["revision"],
            "terminalFailure": terminal_failure,
        }
    )
    if handoff is not None and handoff_incarnation:
        handoff.release(operation_id=operation_id, incarnation=handoff_incarnation)
    return False, service, previous, terminal_failure


async def _observe(
    client: Any,
    name: str,
    spec: PodSpec,
    receipt: dict[str, Any],
    *,
    expected_deployed_image: str,
):
    if not spec.expected_service_uid or not spec.upgrade_attempt_id:
        raise RuntimeError("upgrade recovery authority unavailable")
    from hushh_mcp.services.pod_release import image_digest

    target_image = receipt.get("targetImage")
    source_image = receipt.get("sourceImage", target_image)
    source_digest = image_digest(source_image)
    deployed_image = receipt.get("deployedImage", receipt.get("image"))
    deployed_digest = image_digest(deployed_image)
    hosted_executor = spec.hosted_files_executor is not None
    if (
        not isinstance(target_image, str)
        or source_image != target_image
        or deployed_digest is None
        or deployed_image != expected_deployed_image
        or receipt.get("image") != expected_deployed_image
        or image_digest(expected_deployed_image) != deployed_digest
        or (source_digest is not None and source_digest != deployed_digest)
        or receipt.get("targetDigest", deployed_digest) != deployed_digest
        or receipt.get("sourceDigest", deployed_digest) != deployed_digest
        or (
            hosted_executor
            and (source_digest is None or receipt.get("targetDigest") != source_digest)
        )
    ):
        return None, {}, None
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
    if ready is False:
        if not hosted_executor:
            return False, service, None
        predecessor = receipt.get("predecessor")
        if (
            not isinstance(predecessor, dict)
            or not isinstance(target_image, str)
            or not target_image
        ):
            return None, service, None
        try:
            failure = await asyncio.to_thread(
                observe_terminal_failure,
                client,
                name=name,
                expected_uid=spec.expected_service_uid,
                target_image=target_image,
                deployed_image=expected_deployed_image,
                attempt_id=spec.upgrade_attempt_id,
                expected_generation=receipt["generation"],
                predecessor=predecessor,
            )
        except (RuntimeError, ValueError, KeyError, TypeError):
            return None, service, None
        return False, service, failure
    if ready and expectation is not None:
        require_gcp_connector_configuration(service, expectation)
    return ready, service, None


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


def verified_capabilities(
    spec: PodSpec, service: dict, *, replacement: bool = True
) -> dict[str, Any]:
    """Verify installed configuration once for replacement and recovery callers."""
    if spec.private_gcp_deployment is not None:
        from hushh_mcp.services.hosted_update_configuration import (
            require_preserved_private_configuration,
        )

        frozen = getattr(spec.hosted_admission_guard, "operation", None) == "inspect"
        spec.private_gcp_deployment.verify_observation(service, frozen=frozen)
        require_preserved_private_configuration(service, frozen=frozen)
        if replacement and spec.private_gcp_deployment.hosting_mode == "hussh_hosted":
            entries = service["spec"]["template"]["spec"]["containers"][0]["env"]
            actual = {entry["name"]: entry.get("value") for entry in entries}
            if (
                not spec.upgrade_operation_id
                or actual.get("HUSSH_POD_WRITER_OPERATION") != spec.upgrade_operation_id
            ):
                raise ValueError("Managed upgrade writer operation differs from approved handoff")
    capability_metadata: dict[str, Any] = {}
    if spec.files_upgrade_plan is not None:
        from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan

        plan = FilesCapabilityPlan.model_validate(spec.files_upgrade_plan)
        plan.require_installed(service, hosted=spec.private_gcp_deployment is not None)
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
    client: Any,
    *,
    name: str,
    route: str,
    backend_id: str,
    spec: PodSpec,
    receipt: dict[str, Any],
    expected_deployed_image: str,
) -> BackendHandle | None:
    ready, service, terminal_failure = await _observe(
        client, name, spec, receipt, expected_deployed_image=expected_deployed_image
    )
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
            **({"terminalFailure": terminal_failure} if terminal_failure is not None else {}),
        },
    )


async def observe_hosted_upgrade(
    client: Any,
    *,
    name: str,
    route: str,
    backend_id: str,
    spec: PodSpec,
    receipt: dict[str, Any],
) -> BackendHandle | None:
    from hushh_mcp.services.pod_release import image_digest

    if spec.hosted_files_executor is not None:
        expected_deployed_image = getattr(spec.hosted_files_executor, "deployed_image", None)
    else:
        # Legacy injected GCP backends record the immutable provider image; their
        # source target may still be a tag. The subsequent read verifies this exact
        # image together with the stored service UID and attempt nonce.
        expected_deployed_image = receipt.get("deployedImage", receipt.get("image"))
    if (
        not isinstance(expected_deployed_image, str)
        or image_digest(expected_deployed_image) is None
    ):
        return None
    ready, service, terminal_failure = await _observe(
        client, name, spec, receipt, expected_deployed_image=expected_deployed_image
    )
    if ready is None:
        return None
    if not ready and spec.files_upgrade_plan is not None:
        # A restart has no original PostgreSQL executor session to append a
        # Hosted Files settlement. Provider failure alone cannot clear its lease.
        return None
    return BackendHandle(
        external_agent_id=name,
        a2a_route=route,
        status="live" if ready else "failed",
        backend=backend_id,
        backend_metadata={
            "image": receipt["image"],
            "url": GcpRunClient.service_url(service) or "",
            **({"terminalFailure": terminal_failure} if terminal_failure is not None else {}),
        },
    )
