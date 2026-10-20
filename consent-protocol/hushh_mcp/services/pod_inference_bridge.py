"""Deployment-owned dev inference exception; never a custody/project override."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

BRIDGE_ENV = "HUSSH_POD_DEV_INFERENCE_BRIDGE_JSON"
BRIDGE_PROJECT = "hushh-vertex-personal54"


@dataclass(frozen=True)
class InferenceBridge:
    project: str
    service_account: str


def _configured_bridge() -> InferenceBridge | None:
    from hushh_mcp.runtime_settings import hydrate_runtime_environment

    hydrate_runtime_environment()
    raw = os.getenv(BRIDGE_ENV, "")
    if not raw:
        return None
    try:
        if os.getenv("HUSHH_DEPLOY_ENV") != "dev" or len(raw) > 1024:
            raise ValueError
        value = json.loads(raw)
        if (
            not isinstance(value, dict)
            or set(value) != {"project", "serviceAccount"}
            or value["project"] != BRIDGE_PROJECT
            or not isinstance(value["serviceAccount"], str)
            or re.fullmatch(
                r"one-pod-[a-z0-9-]+@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com",
                value["serviceAccount"],
            )
            is None
        ):
            raise ValueError
        return InferenceBridge(value["project"], value["serviceAccount"])
    except (TypeError, ValueError):
        raise RuntimeError("Dev pod inference bridge configuration is invalid") from None


def render_inference_bridge(*, service_account: str) -> list[dict[str, str]]:
    """Only the configured identity receives the exception on a new deployment.

    Image updates preserve the observed policy, including absence. This renderer
    does not authorize retrofitting an existing owner's configuration.
    """
    bridge = _configured_bridge()
    if bridge is None or bridge.service_account != service_account:
        return []
    return [
        {
            "name": BRIDGE_ENV,
            "value": json.dumps(
                {"project": bridge.project, "serviceAccount": bridge.service_account},
                separators=(",", ":"),
            ),
        }
    ]


def owner_inference_bridge() -> InferenceBridge | None:
    """Validate the exact owner topology before constructing any model client."""
    bridge = _configured_bridge()
    if bridge is None:
        return None
    from hushh_mcp.runtime_settings import _owner_adc_project, pod_user_adc_enabled
    from hushh_mcp.services.user_gcp_backend import pod_service_account_id

    project = _owner_adc_project()
    expected = f"{pod_service_account_id(os.environ['HUSSH_ID'])}@{project}.iam.gserviceaccount.com"
    if (
        not pod_user_adc_enabled()
        or bridge.service_account != expected
        or not os.getenv("K_SERVICE")
        or any(
            os.getenv(name)
            for name in ("GCE_METADATA_HOST", "GCE_METADATA_ROOT", "GCE_METADATA_IP")
        )
    ):
        raise RuntimeError("Dev pod inference bridge identity is invalid")
    return bridge
