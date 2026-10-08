"""Approved Azure image replacement values; no provider writes or credentials.

The provider upgrade owner retains handoff, incarnation fencing and durable
receipts. This port preserves the selected runtime shape and custody references.
"""

from __future__ import annotations

import copy
from typing import Any

from hushh_mcp.services.azure_agent_setup import parse_source_image
from hushh_mcp.services.azure_container_app_renderer import refuse_metered_configuration

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
