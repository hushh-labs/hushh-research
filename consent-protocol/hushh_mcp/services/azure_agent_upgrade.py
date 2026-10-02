"""Move an owner Azure agent onto an approved digest, under the person's JIT token.

There is no ARM ETag for a container app (measured), so the write is fenced by what
Hussh recorded instead: the hub's upgrade lease (held by the orchestrator around this
call), the agent's ``hussh-incarnation`` tag, which must equal the recorded
``serviceUid``, and ``systemData.createdAt``, re-read immediately before the PUT. A
replaced or re-created agent changes one of them and the upgrade refuses.

The new revision's suffix is derived from the attempt id, so the acknowledgement
names exactly the revision this attempt created. The previous revision keeps serving
until the new one is ready (single revision mode activates the new one only then).
Files background organization is not available on Azure yet, so a Files plan refuses.
"""

from __future__ import annotations

import copy
import logging
from typing import TYPE_CHECKING, Any

from hushh_mcp.services.azure_agent_setup import binding_is_valid, parse_source_image
from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_container_app_renderer import (
    INCARNATION_TAG,
    image_reference,
    refuse_metered_configuration,
)
from hushh_mcp.services.azure_setup_applier import resolve
from hushh_mcp.services.azure_setup_plan import (
    NONCE_TAG,
    Scopes,
    import_image_step,
    resource_names,
)
from hushh_mcp.services.compute_backend import BackendHandle, PodSpec

if TYPE_CHECKING:
    from hushh_mcp.services.user_azure_backend import UserAzureBackend

logger = logging.getLogger(__name__)

#: Writable fields of a container app; everything else ARM computes.
_WRITABLE = ("location", "tags", "identity")
_WRITABLE_PROPERTIES = ("environmentId", "workloadProfileName", "configuration", "template")


def revision_suffix(attempt_id: str) -> str:
    """Lowercase alphanumeric, short, and unique to one upgrade attempt."""
    clean = "".join(ch for ch in str(attempt_id or "").lower() if ch.isalnum())
    if len(clean) < 8:
        raise ValueError("an upgrade needs its attempt id to name the new revision")
    return f"u{clean[:12]}"


def replacement_body(app: dict[str, Any], *, image: str, suffix: str) -> dict[str, Any]:
    """The existing agent with one image and one revision suffix changed."""
    body = {key: copy.deepcopy(app[key]) for key in _WRITABLE if key in app}
    properties = app.get("properties") or {}
    body["properties"] = {
        key: copy.deepcopy(properties[key]) for key in _WRITABLE_PROPERTIES if key in properties
    }
    template = body["properties"].setdefault("template", {})
    template["revisionSuffix"] = suffix
    containers = template.get("containers") or []
    if len(containers) != 1:
        raise ValueError("the agent runs exactly one container")
    containers[0]["image"] = image
    # Secrets are Key Vault references (name, URL, identity), so the GET shape is
    # exactly what a replace must carry; no secret value ever transits Hussh here.
    refuse_metered_configuration(body)
    return body


def _fence(app: dict[str, Any], spec: PodSpec, expected_uid: str) -> tuple[str, str]:
    tags = app.get("tags") or {}
    if not binding_is_valid(tags, spec.hushh_id) or tags.get(INCARNATION_TAG) != expected_uid:
        raise RuntimeError("pod incarnation changed; reconcile before updating")
    created = str((app.get("systemData") or {}).get("createdAt") or "")
    return str(tags.get(NONCE_TAG) or ""), created


def _image(app: dict[str, Any]) -> str:
    containers = ((app.get("properties") or {}).get("template") or {}).get("containers") or [{}]
    return str(containers[0].get("image") or "")


def upgrade_agent(backend: UserAzureBackend, spec: PodSpec, arm: ArmClient) -> BackendHandle:
    """Synchronous: import the digest, re-fence, replace, acknowledge, wait."""
    if spec.files_upgrade_plan is not None:
        raise ValueError("Files background organization is not available on Azure yet")
    expected = str(spec.expected_service_uid or "").strip()
    if not expected:
        raise RuntimeError("pod incarnation unverified; recovery required before upgrade")
    registry, repository, digest = parse_source_image(str(spec.upgrade_target_image or ""))
    api = API_VERSIONS["container_apps"]
    app = arm.get(backend.app_id, api_version=api, op="upgrade")
    nonce, created = _fence(app, spec, expected)
    names = resource_names(backend.plan_inputs(spec.hushh_id, nonce))
    scopes = Scopes(backend.plan_inputs(spec.hushh_id, nonce), names)
    target = image_reference(f"{names.registry}.azurecr.io", digest)
    previous = _image(app)
    if previous == target:
        current = backend.verified_handle(spec.hushh_id, backend.observe_sync())
        return _with_metadata(current, upgraded=False, source_image=spec.upgrade_target_image)
    step = import_image_step(scopes, registry, repository)
    arm.post(
        step.path,
        api_version=API_VERSIONS[step.api],
        body=resolve(step.body, {"imageDigest": digest}),
        op="importing_image",
    )
    current = arm.get(backend.app_id, api_version=api, op="upgrade")
    if _fence(current, spec, expected) != (nonce, created):
        raise RuntimeError("the agent changed while its image was imported; nothing was replaced")
    suffix = revision_suffix(spec.upgrade_attempt_id or spec.upgrade_operation_id or "")
    started = arm.request(
        "PUT",
        backend.app_id,
        api_version=api,
        body=replacement_body(current, image=target, suffix=suffix),
        op="deploying_agent",
    )
    revision = f"{names.container_app}--{suffix}"
    if spec.on_upgrade_ack is not None:
        spec.on_upgrade_ack(
            {
                "version": 1,
                "service": backend.app_id,
                "serviceUid": expected,
                "revision": revision,
                "attemptId": spec.upgrade_attempt_id or "",
                "image": target,
            }
        )
    if arm.needs_poll(started):
        arm.wait(started, "deploying_agent")
    observation = backend.observe_sync()
    properties = observation.app.get("properties") or {}
    if observation.image != target or properties.get("latestRevisionName") != revision:
        raise RuntimeError("the new revision did not become the agent's; the previous one serves")
    handle = backend.verified_handle(spec.hushh_id, observation)
    logger.info("user_azure_backend.upgraded revision=%s ready=%s", revision, observation.ready)
    return _with_metadata(
        handle, upgraded=True, source_image=spec.upgrade_target_image, previous_image=previous
    )


def _with_metadata(handle: BackendHandle, **extra: Any) -> BackendHandle:
    return BackendHandle(
        external_agent_id=handle.external_agent_id,
        a2a_route=handle.a2a_route,
        status=handle.status,
        backend=handle.backend,
        backend_metadata={**(handle.backend_metadata or {}), **extra},
    )


__all__ = ["replacement_body", "revision_suffix", "upgrade_agent"]
