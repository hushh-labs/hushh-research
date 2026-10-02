"""The agent as a ``Microsoft.App/containerApps`` body in the person's subscription.

The pod's environment contract is the one the managed renderer already proves
(``GcpBackend.render_deploy_config``): identity pins, the hub door, the consent
verifying keys, the propagated kill switches. It is reused, not forked, and then
adjusted exactly where an owner Azure subscription differs:

* the managed-only strip list from ``user_gcp_backend._MANAGED_ONLY_ENV`` applies
  unchanged, so no Hussh key, bucket or model coordinate reaches a person's cloud;
* storage, custody, identity and model coordinates are the Azure rows of the agent
  environment contract in ``byoc-azure.md`` (topology only, never behaviour);
* ``APP_SIGNING_KEY`` is a Key Vault secret REFERENCE resolved by the platform with
  the agent's own identity, never a value in the body.

Shape: single revision mode, 0..1 replicas (one writer, scales to zero), 0.5 vCPU /
1 GiB, HTTP startup and liveness probes on ``/health``, external ingress (Container
Apps has no invoker lock; the in-pod wall ``api/middlewares/pod_ingress.py`` is the
lock), image pulled by digest from the person's own registry with the agent identity.

Refused, each a separate $0.10/hour environment meter: private endpoints and the
maintenance-window configuration.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from hushh_mcp.services.compute_backend import POD_CPU_MILLIS, POD_MEMORY, PodSpec

POD_IMAGE_REPOSITORY = "consent-protocol-pod"
SIGNING_SECRET_NAME = "app-signing-key"  # noqa: S105 - a secret NAME, not a value
INCARNATION_TAG = "hussh-incarnation"
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")

#: Rendered by the managed renderer for Vertex ADC on hushh's or a GCP owner's
#: identity. No such identity exists in an Azure subscription.
_GOOGLE_MODEL_ENV = frozenset({"GOOGLE_GENAI_USE_VERTEXAI"})

#: Keys whose presence anywhere in a body creates a metered or private-network extra.
_REFUSED_KEYS = frozenset(
    {
        "privateEndpointConnections",
        "privateEndpoints",
        "vnetConfiguration",
        "maintenanceConfigurations",
        "maintenanceConfiguration",
        "scheduledEntries",
    }
)


class MeteredConfigurationRefused(ValueError):
    """The body asks for an extra the agent's cost model deliberately excludes."""


@dataclass(frozen=True)
class AgentCoordinates:
    """Everything the body needs that the setup created, all topology."""

    location: str
    environment_id: str
    identity_id: str
    identity_client_id: str
    registry_server: str
    image_digest: str
    blob_url: str
    key_vault_key: str
    signing_secret_url: str
    incarnation: str
    hub_caller_emails: str
    openai_endpoint: Optional[str] = None
    openai_deployment: Optional[str] = None
    tags: dict[str, str] = field(default_factory=dict)


def refuse_metered_configuration(body: Any, *, where: str = "body") -> None:
    """Raise when a private endpoint or maintenance window appears anywhere in ``body``."""
    if isinstance(body, dict):
        for key, value in body.items():
            if key in _REFUSED_KEYS:
                raise MeteredConfigurationRefused(
                    f"{where}.{key}: refused, it adds a separate hourly environment meter"
                )
            refuse_metered_configuration(value, where=f"{where}.{key}")
    elif isinstance(body, list):
        for index, value in enumerate(body):
            refuse_metered_configuration(value, where=f"{where}[{index}]")


def _shared_env(spec: PodSpec, location: str) -> list[dict[str, Any]]:
    """The proven pod env contract, minus everything a person's cloud must not get."""
    from hushh_mcp.services.gcp_backend import GcpBackend  # noqa: PLC0415
    from hushh_mcp.services.user_gcp_backend import _MANAGED_ONLY_ENV  # noqa: PLC0415

    rendered = GcpBackend(project="", region=location, image="", live=False).render_deploy_config(
        spec
    )
    container = rendered["spec"]["template"]["spec"]["containers"][0]
    stripped = _MANAGED_ONLY_ENV | _GOOGLE_MODEL_ENV
    return [
        {"name": entry["name"], "value": str(entry.get("value", ""))}
        for entry in container.get("env", [])
        if entry["name"] not in stripped and "valueFrom" not in entry
    ]


def _azure_env(coords: AgentCoordinates) -> list[dict[str, Any]]:
    from hushh_mcp.services.byoc_key_custody import (  # noqa: PLC0415
        WRAPPED_KEY_OBJECT_ENV,
        WRAPPED_LOG_KEY_OBJECT,
    )

    env = [
        {"name": "POD_STORAGE_BACKEND", "value": "commit_log"},
        {"name": "POD_STORAGE_AZURE_BLOB_URL", "value": coords.blob_url},
        {"name": "HUSSH_POD_KEY_VAULT_KEY", "value": coords.key_vault_key},
        {"name": WRAPPED_KEY_OBJECT_ENV, "value": WRAPPED_LOG_KEY_OBJECT},
        {"name": "POD_DURABLE_IDENTITY_ENABLED", "value": "true"},
        {"name": "POD_AGENT_MEMORY_ENABLED", "value": "true"},
        {"name": "AZURE_CLIENT_ID", "value": coords.identity_client_id},
        # No Vertex here: BYOK Gemini arrives per turn and needs no project.
        {"name": "GOOGLE_GENAI_USE_VERTEXAI", "value": "false"},
        {"name": "HUSSH_POD_HUB_CALLER_EMAILS", "value": coords.hub_caller_emails},
        {"name": "APP_SIGNING_KEY", "secretRef": SIGNING_SECRET_NAME},
    ]
    if coords.openai_endpoint and coords.openai_deployment:
        env += [
            {"name": "AZURE_OPENAI_ENDPOINT", "value": coords.openai_endpoint},
            {"name": "AZURE_OPENAI_DEPLOYMENT", "value": coords.openai_deployment},
        ]
    return env


def _probe(kind: str, *, period: int, failures: int) -> dict[str, Any]:
    # /health, never /health/ready: readiness checks a database the pod has no
    # credential for, so a probe one path further would mean no pod ever starts.
    return {
        "type": kind,
        "httpGet": {"path": "/health", "port": 8080},
        "timeoutSeconds": 5,
        "periodSeconds": period,
        "failureThreshold": failures,
    }


def image_reference(registry_server: str, digest: str) -> str:
    if not _DIGEST.match(digest) and not digest.startswith("${"):
        raise ValueError("the agent image is pinned by sha256 digest, never a tag")
    return f"{registry_server}/{POD_IMAGE_REPOSITORY}@{digest}"


def render_container_app(spec: PodSpec, coords: AgentCoordinates) -> dict[str, Any]:
    """The full create-or-replace body. Pure; refuses metered extras before returning."""
    if not coords.hub_caller_emails.strip():
        raise ValueError("the in-pod wall needs the hub caller identity; refusing a public pod")
    env = _shared_env(spec, coords.location)
    replaced = {entry["name"] for entry in _azure_env(coords)}
    env = [entry for entry in env if entry["name"] not in replaced] + _azure_env(coords)
    body: dict[str, Any] = {
        "location": coords.location,
        "tags": {**coords.tags, INCARNATION_TAG: coords.incarnation},
        "identity": {"type": "UserAssigned", "userAssignedIdentities": {coords.identity_id: {}}},
        "properties": {
            "environmentId": coords.environment_id,
            "workloadProfileName": "Consumption",
            "configuration": {
                "activeRevisionsMode": "Single",
                "ingress": {
                    "external": True,
                    "targetPort": 8080,
                    "transport": "http",
                    "allowInsecure": False,
                    "traffic": [{"latestRevision": True, "weight": 100}],
                },
                "registries": [{"server": coords.registry_server, "identity": coords.identity_id}],
                "secrets": [
                    {
                        "name": SIGNING_SECRET_NAME,
                        "keyVaultUrl": coords.signing_secret_url,
                        "identity": coords.identity_id,
                    }
                ],
            },
            "template": {
                "containers": [
                    {
                        "name": "pod",
                        "image": image_reference(coords.registry_server, coords.image_digest),
                        "resources": {"cpu": POD_CPU_MILLIS / 1000, "memory": POD_MEMORY},
                        "env": env,
                        "probes": [
                            _probe("Startup", period=5, failures=24),
                            _probe("Liveness", period=30, failures=3),
                        ],
                    }
                ],
                # maxReplicas 1 is correctness, not cost: one writer per sealed log.
                "scale": {"minReplicas": 0, "maxReplicas": 1},
            },
        },
    }
    refuse_metered_configuration(body)
    return body


__all__ = [
    "INCARNATION_TAG",
    "POD_IMAGE_REPOSITORY",
    "SIGNING_SECRET_NAME",
    "AgentCoordinates",
    "MeteredConfigurationRefused",
    "image_reference",
    "refuse_metered_configuration",
    "render_container_app",
]
