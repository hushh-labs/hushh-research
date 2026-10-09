"""Azure Files installed-configuration readback behind the existing backend."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from hushh_mcp.services.azure_setup_plan import NONCE_TAG, Scopes, group_id, resource_names
from hushh_mcp.services.compute_backend import BackendHandle, PodSpec

if TYPE_CHECKING:
    from hushh_mcp.services.azure_agent_observation import AzureAgentObservation
    from hushh_mcp.services.azure_container_app_renderer import AgentCoordinates
    from hushh_mcp.services.user_azure_backend import UserAzureBackend

from hushh_mcp.services.azure_agent_observation import assigned_identity


def require_installation(app: dict[str, Any], *, storage_id: str, identity_id: str) -> None:
    template = (app.get("properties") or {}).get("template") or {}
    containers = template.get("containers") or []
    if len(containers) != 1:
        raise ValueError("Files requires the verified single-worker pod")
    entries = containers[0].get("env") or []
    env = {entry.get("name"): entry.get("value") for entry in entries}
    if len(env) != len(entries):
        raise ValueError("Pod environment contains duplicate settings")
    account = storage_id.rsplit("/", 1)[-1]
    principal, client = assigned_identity(app, identity_id)
    properties = app.get("properties") or {}
    if (
        not principal
        or not client
        or (properties.get("configuration") or {}).get("activeRevisionsMode") != "Single"
        or (template.get("scale") or {}).get("maxReplicas") != 1
    ):
        raise ValueError("Files requires the owner's identity and single-writer configuration")
    expected = {
        "POD_FILES_ENABLED": "true",
        "POD_FILES_AZURE_STORAGE_RESOURCE_ID": storage_id,
        "POD_FILES_AZURE_QUEUE_URL": f"https://{account}.queue.core.windows.net/files-organization",
        "POD_STORAGE_AZURE_BLOB_URL": f"https://{account}.blob.core.windows.net/pod",
        "AZURE_CLIENT_ID": client,
    }
    if any(env.get(key) != value for key, value in expected.items()):
        raise ValueError("Files installation configuration is not verified")
    rules = (template.get("scale") or {}).get("rules") or []
    matching = [rule.get("custom") for rule in rules if rule.get("name") == "files"]
    if matching != [
        {
            "type": "azure-queue",
            "identity": identity_id,
            "metadata": {
                "accountName": account,
                "queueName": "files-organization",
                "queueLength": "1",
                "activationQueueLength": "0",
                "queueLengthStrategy": "all",
            },
        }
    ]:
        raise ValueError("Files queue lifecycle is not verified")


async def inspect_files_capability(backend: UserAzureBackend, spec: PodSpec) -> dict:
    observation = await backend.observe()
    if not observation.present:
        raise observation.refusal("inspect Files on")
    handle = backend.verified_handle(spec.hushh_id, observation)
    if (handle.backend_metadata or {}).get("serviceUid") != spec.expected_service_uid:
        raise ValueError("Files requires the current pod incarnation")
    return observation.app


async def discover_files_upgrade_ack(backend: UserAzureBackend, spec: PodSpec) -> dict | None:
    from hushh_mcp.services.azure_agent_upgrade import revision_suffix
    from hushh_mcp.services.pod_files.azure_capability import AzureFilesCapabilityPlan
    from hushh_mcp.services.pod_release import image_digest

    plan = AzureFilesCapabilityPlan.model_validate(spec.files_upgrade_plan)
    app = await backend.inspect_files_capability(spec)
    revision = f"ca-hussh-one-pod--{revision_suffix(spec.upgrade_attempt_id or '')}"
    props = app.get("properties") or {}
    if (
        props.get("latestRevisionName") != revision
        or props.get("latestReadyRevisionName") != revision
    ):
        return None
    plan.require_installed(app)
    image = props["template"]["containers"][0]["image"]
    if image_digest(image) != image_digest(plan.targetImage):
        return None
    return {
        "version": 1,
        "service": backend.app_id,
        "serviceUid": plan.serviceUid,
        "revision": revision,
        "attemptId": spec.upgrade_attempt_id,
        "image": image,
    }


async def qualify_files_upgrade_prefix(
    backend: UserAzureBackend, spec: PodSpec, *, count: int
) -> list[dict]:
    from hushh_mcp.services.azure_arm_client import API_VERSIONS
    from hushh_mcp.services.user_azure_backend import current_jit_token

    from .azure_bootstrap import AzureFilesBootstrap
    from .azure_capability import AzureFilesCapabilityPlan
    from .azure_checkpoint import qualify_readback

    plan = AzureFilesCapabilityPlan.model_validate(spec.files_upgrade_plan)
    if count != 2 or plan.service.lower() != backend.app_id.lower():
        raise ValueError("Files reconciliation is outside the approved prefix")
    arm = backend._person_factory(current_jit_token())

    def read():
        app = arm.get(
            backend.app_id, api_version=API_VERSIONS["container_apps"], op="files_reconcile"
        )
        plan.require_observation(app)
        AzureFilesBootstrap(plan, arm).preflight()
        completed = []
        for call in plan.operations()[:count]:
            value = arm.get(
                call["path"], api_version=API_VERSIONS[call["api"]], op="files_reconcile"
            )
            completed.append(
                {
                    "step": call["step"],
                    "ok": True,
                    "status": 200,
                    "observation": qualify_readback(call, value),
                }
            )
        plan.require_observation(
            arm.get(
                backend.app_id, api_version=API_VERSIONS["container_apps"], op="files_reconcile"
            )
        )
        return completed

    return await asyncio.to_thread(read)


async def attach_with_files(backend: UserAzureBackend, spec: PodSpec) -> BackendHandle:
    """Attach to the agent the person's setup created; never create one here."""
    observation = await backend.observe()
    if not observation.present:
        raise observation.refusal("attach")
    handle = backend.verified_handle(spec.hushh_id, observation)
    backend._require_files_installation(spec.hushh_id, observation, spec.files_library_enabled)
    spec.emit_stage("host_created")
    if spec.provision_attempt_id and spec.on_provision_ack is not None:
        metadata = handle.backend_metadata or {}
        target = backend.provision_target_for(spec)
        await asyncio.to_thread(
            spec.on_provision_ack,
            {
                "service": backend.app_id,
                "serviceUid": metadata["serviceUid"],
                "project": group_id(target["subscriptionId"], target["resourceGroup"]),
                "region": target["region"],
                "backend": backend.backend_id,
                "image": metadata["image"],
            },
        )
    if handle.status == "live":
        spec.emit_stage("host_serving")
    return handle


def require_files_installation(
    backend: UserAzureBackend, hushh_id: str, observation: AzureAgentObservation, enabled: bool
) -> None:
    if enabled:
        inputs = backend.plan_inputs(
            hushh_id, observation.tags.get(NONCE_TAG, ""), files_enabled=True
        )
        scopes = Scopes(inputs, resource_names(inputs))
        require_installation(
            observation.app, storage_id=scopes.storage, identity_id=scopes.identity
        )


def configure_files(body: dict[str, Any], coords: AgentCoordinates) -> None:
    """Bind the optional Files queue and custody to this exact owner resource group."""
    if not coords.files_storage_resource_id:
        return
    env = body["properties"]["template"]["containers"][0]["env"]
    # Only the reviewed Files capability plan supplies this coordinate.
    # Preserve HTTP wake and count leased messages in KEDA's scale decision.
    account = coords.files_storage_resource_id.rsplit("/", 1)[-1]
    blob = urlsplit(coords.blob_url)
    if (
        blob.netloc != f"{account}.blob.core.windows.net"
        or blob.scheme != "https"
        or blob.query
        or blob.fragment
        or not coords.files_storage_resource_id.startswith(
            coords.identity_id.split("/providers/", 1)[0]
            + "/providers/Microsoft.Storage/storageAccounts/"
        )
    ):
        raise ValueError("Files storage must belong to this owner's agent resource group")
    env += [
        {"name": "POD_FILES_ENABLED", "value": "true"},
        {
            "name": "POD_FILES_AZURE_STORAGE_RESOURCE_ID",
            "value": coords.files_storage_resource_id,
        },
        {
            "name": "POD_FILES_AZURE_QUEUE_URL",
            "value": f"https://{account}.queue.core.windows.net/files-organization",
        },
    ]
    body["properties"]["template"]["scale"]["rules"] = [
        {"name": "http", "http": {"metadata": {"concurrentRequests": "8"}}},
        {
            "name": "files",
            "custom": {
                "type": "azure-queue",
                "identity": coords.identity_id,
                "metadata": {
                    "accountName": account,
                    "queueName": "files-organization",
                    "queueLength": "1",
                    "activationQueueLength": "0",
                    "queueLengthStrategy": "all",
                },
            },
        },
    ]


async def discover_with_files(backend: UserAzureBackend, hushh_id: str) -> BackendHandle | None:
    """Adopt only the recorded owner, identity, approved image and Files custody."""
    from hushh_mcp.services.azure_agent_observation import adoption_refusal
    from hushh_mcp.services.user_azure_backend import logger

    observation = await backend.observe()
    if not observation.present:
        if observation.absence_confirmed:
            return None
        raise observation.refusal("adopt")
    try:
        handle = backend.verified_handle(hushh_id, observation)
    except RuntimeError:
        logger.warning("user_azure_backend.discover_foreign group=%s", backend._group)
        return None
    refused = adoption_refusal(
        handle.backend_metadata or {},
        recorded_principal=backend._recorded_principal,
        recorded_digest=backend._recorded_digest,
    )
    if refused:
        logger.warning("user_azure_backend.discover_refused reason=%s", refused)
        return None
    backend._require_files_installation(hushh_id, observation, backend._files_library_enabled)
    metadata = {**(handle.backend_metadata or {}), "adopted": True}
    return BackendHandle(
        external_agent_id=handle.external_agent_id,
        a2a_route=handle.a2a_route,
        status=handle.status,
        backend=handle.backend,
        backend_metadata=metadata,
    )
