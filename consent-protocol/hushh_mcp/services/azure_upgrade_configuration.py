"""Approved Azure image replacement values; no provider writes or credentials.

The provider upgrade owner retains handoff, incarnation fencing and durable
receipts. This port preserves the selected runtime shape and custody references.
"""

from __future__ import annotations

import copy
from typing import Any

from hushh_mcp.services.azure_agent_setup import parse_source_image
from hushh_mcp.services.azure_container_app_renderer import refuse_metered_configuration
from hushh_mcp.services.compute_backend import BackendHandle, PodSpec
from hushh_mcp.services.pod_connector_configuration import (
    reconcile_connector_environment,
    require_connector_configuration,
)

#: Writable fields of a container app; everything else ARM computes.
_WRITABLE = ("location", "tags", "identity")
_WRITABLE_PROPERTIES = ("environmentId", "workloadProfileName", "configuration", "template")


def revision_suffix(attempt_id: str) -> str:
    """Lowercase alphanumeric, short, and unique to one upgrade attempt."""
    clean = "".join(ch for ch in str(attempt_id or "").lower() if ch.isalnum())
    if len(clean) < 8:
        raise ValueError("an upgrade needs its attempt id to name the new revision")
    return f"u{clean[:12]}"


#: The economy idle window every scale-to-zero agent runs with (the renderer's value).
IDLE_GRACE_ENV = {"name": "POD_IDLE_GRACE_SECONDS", "value": "600"}


def _carry_idle_window(template: dict[str, Any], container: dict[str, Any]) -> None:
    """Give a scale-to-zero agent set up before the idle window existed that window.

    Azure has one profile (minReplicas 0), so this is part of it, not an opt-in; an
    agent without it never released an idle Puppy socket and stayed warm. A value the
    agent already carries is never changed.
    """
    if ((template.get("scale") or {}).get("minReplicas")) != 0:
        return
    env = container.setdefault("env", [])
    if not any(entry.get("name") == IDLE_GRACE_ENV["name"] for entry in env):
        env.append(dict(IDLE_GRACE_ENV))


def replacement_body(
    app: dict[str, Any],
    *,
    image: str,
    suffix: str,
    connector_environment: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
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
    if connector_environment is not None:
        containers[0]["env"] = reconcile_connector_environment(
            containers[0].get("env", []), connector_environment
        )
    _carry_idle_window(template, containers[0])
    # Secrets are Key Vault references (name, URL, identity), so the GET shape is
    # exactly what a replace must carry; no secret value ever transits Hussh here.
    refuse_metered_configuration(body)
    return body


def verified_import_source(approved: str, source: str) -> tuple[str, str, str]:
    """(registry, repository, digest) the person's registry imports the approved image from.

    The approval, the acknowledgement and the agent's reported image all stay bound to
    ``approved``; only where those bytes are read from moves, to the pod-only release
    repository the image reader is granted (``release_source``), exactly as setup does.
    Reading the hub's own reference instead would ask the reader for a repository it is
    deliberately not granted. A digest names exact bytes, so a mapping that reads any
    other digest is refused.
    """
    _, _, approved_digest = parse_source_image(approved)
    registry, repository, digest = parse_source_image(source)
    if digest != approved_digest:
        raise RuntimeError("the import source must name the approved digest")
    return registry, repository, digest


def upgrade_acknowledgement(
    service: str,
    spec: PodSpec,
    revision: str,
    image: str,
    connector_environment: list[dict[str, str]],
) -> dict[str, Any]:
    """Bind provider acceptance to this attempt and its admitted public configuration."""
    return {
        "version": 1,
        "service": service,
        "serviceUid": str(spec.expected_service_uid or ""),
        "revision": revision,
        "attemptId": spec.upgrade_attempt_id or "",
        "image": image,
        "connectorEnvironment": connector_environment,
    }


def verified_files(
    handle: BackendHandle,
    spec: PodSpec,
    app: dict,
    connector_environment: list[dict[str, str]] | None = None,
) -> BackendHandle:
    if connector_environment is not None:
        require_connector_configuration(app, connector_environment)
    if spec.browser_upgrade_plan is not None:
        import json

        from hushh_mcp.services.pod_browser.azure_capability import AzureBrowserCapabilityPlan

        browser = AzureBrowserCapabilityPlan.model_validate_json(
            json.dumps(spec.browser_upgrade_plan)
        )
        browser.require_installed(app)
        handle = with_metadata(
            handle, browserCapability={"planDigest": browser.digest, "status": "configured"}
        )
    if spec.files_upgrade_plan is None:
        return handle
    from hushh_mcp.services.pod_files.azure_capability import AzureFilesCapabilityPlan

    plan = AzureFilesCapabilityPlan.model_validate(spec.files_upgrade_plan)
    plan.require_installed(app)
    return with_metadata(handle, filesCapability={"planDigest": plan.digest, "status": "enabled"})


def with_metadata(handle: BackendHandle, **extra: Any) -> BackendHandle:
    return BackendHandle(
        external_agent_id=handle.external_agent_id,
        a2a_route=handle.a2a_route,
        status=handle.status,
        backend=handle.backend,
        backend_metadata={**(handle.backend_metadata or {}), **extra},
    )
