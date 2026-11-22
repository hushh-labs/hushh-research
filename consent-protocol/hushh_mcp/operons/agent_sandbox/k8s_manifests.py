# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Portable Kubernetes Agent Sandbox manifest renderers (FedRAMP High baseline, #9744).

Produces `extensions.agents.x-k8s.io/v1beta1` (`SandboxTemplate`,
`SandboxWarmPool`, `SandboxClaim`) and `networking.k8s.io/v1` default-deny
`NetworkPolicy` resources runnable across GKE Autopilot (`microvm` / `kata-clh`
and `gvisor`), AWS GovCloud EKS (`kata`), and Azure Gov AKS (`kata`).
"""

from __future__ import annotations

import datetime
import ipaddress
import re
import time
from typing import Any, Literal

from hushh_mcp.operons.pod_workspace.command_policy import METADATA_NO_PROXY

AGENT_SANDBOX_API_VERSION = "agents.x-k8s.io/v1beta1"
AGENT_SANDBOX_EXTENSIONS_API_VERSION = "extensions.agents.x-k8s.io/v1beta1"
DEFAULT_CPU_MILLIS = 2000
DEFAULT_MEMORY_LIMIT = "4Gi"
DEFAULT_SANDBOX_UID = 10001
DEFAULT_EGRESS_PROXY_PORT = 3128
DEFAULT_MODEL_GATEWAY_PORT = 8082
DEFAULT_EGRESS_PROXY_URL = (
    "http://sentinel-egress-proxy.hussh-sandbox-system.svc.cluster.local:3128"
)
SANDBOX_NO_PROXY = (
    f"{METADATA_NO_PROXY},.hussh-sandbox-system.svc.cluster.local,.hussh-sandbox-system.svc"
)
DEFAULT_STANDBY_COMMAND = (
    "/opt/venv/bin/python",
    "-m",
    "hushh_mcp.services.agent_sandbox.virgin_standby",
)
K8S_MANIFEST_INVARIANT_ERROR = "AGENT_SANDBOX_MANIFEST_INVALID"

SandboxRuntimeClass = Literal["microvm", "kata", "gvisor"]
SUPPORTED_SANDBOX_RUNTIME_CLASSES = frozenset({"microvm", "kata", "gvisor"})

_DNS_LABEL_RE = re.compile(r"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$")
_IMMUTABLE_IMAGE_RE = re.compile(r"^.+@sha256:[a-f0-9]{64}$")
_RESERVED_FORBIDDEN_ENV = (
    "HUSSH_POD_ID",
    "HUSSH_OWNER_ID",
    "HUSSH_POD_MEMORY_KEY",
    "APP_SIGNING_KEY",
    "VAULT_DATA_KEY",
)


def _require_dns_label(value: str, *, field_name: str) -> str:
    cleaned = str(value or "").strip()
    if not _DNS_LABEL_RE.fullmatch(cleaned):
        raise ValueError(f"{K8S_MANIFEST_INVARIANT_ERROR}: invalid {field_name} {value!r}")
    return cleaned


def render_sandbox_template(
    *,
    name: str = "hussh-one-sandbox-v1",
    namespace: str = "hussh-agents",
    image_ref: str,
    runtime_class: SandboxRuntimeClass = "microvm",
    cpu_millis: int = DEFAULT_CPU_MILLIS,
    memory_limit: str = DEFAULT_MEMORY_LIMIT,
    egress_proxy_url: str = DEFAULT_EGRESS_PROXY_URL,
    sentinel_service_ip: str | None = None,
    command: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    """Render a virgin hardened v1beta1 SandboxTemplate with zero owner state or SA tokens."""
    tpl_name = _require_dns_label(name, field_name="template name")
    ns = _require_dns_label(namespace, field_name="namespace")
    clean_image = str(image_ref or "").strip()
    if not _IMMUTABLE_IMAGE_RE.fullmatch(clean_image):
        raise ValueError(
            f"{K8S_MANIFEST_INVARIANT_ERROR}: immutable @sha256 digest image_ref required"
        )
    if runtime_class not in SUPPORTED_SANDBOX_RUNTIME_CLASSES:
        raise ValueError(
            f"{K8S_MANIFEST_INVARIANT_ERROR}: unsupported runtimeClassName {runtime_class!r}"
        )
    if cpu_millis < 500 or cpu_millis > 8000:
        raise ValueError(f"{K8S_MANIFEST_INVARIANT_ERROR}: cpu_millis out of bounds")
    clean_proxy = str(egress_proxy_url or "").strip()
    if not clean_proxy.startswith(("http://", "https://")):
        raise ValueError(f"{K8S_MANIFEST_INVARIANT_ERROR}: valid egress_proxy_url required")

    host_aliases: list[dict[str, Any]] | None = None
    if sentinel_service_ip is not None:
        try:
            parsed_ip = ipaddress.ip_address(str(sentinel_service_ip).strip())
        except ValueError as exc:
            raise ValueError(
                f"{K8S_MANIFEST_INVARIANT_ERROR}: valid sentinel_service_ip required"
            ) from exc
        host_aliases = [
            {
                "ip": str(parsed_ip),
                "hostnames": [
                    "sentinel-egress-proxy.hussh-sandbox-system.svc.cluster.local",
                    "sentinel-egress-proxy.hussh-sandbox-system.svc",
                ],
            }
        ]

    entrypoint = list(command) if command is not None else list(DEFAULT_STANDBY_COMMAND)
    if not entrypoint or not all(isinstance(part, str) and part.strip() for part in entrypoint):
        raise ValueError(f"{K8S_MANIFEST_INVARIANT_ERROR}: non-empty command is required")

    env_list = [
        {"name": "HUSSH_POD_MODE", "value": "1"},
        {"name": "HUSSH_SANDBOX_PROFILE", "value": "virgin_pool_v1"},
        {"name": "TMPDIR", "value": "/run/hussh-tmp"},
        {"name": "HTTP_PROXY", "value": clean_proxy},
        {"name": "HTTPS_PROXY", "value": clean_proxy},
        {"name": "http_proxy", "value": clean_proxy},
        {"name": "https_proxy", "value": clean_proxy},
        {"name": "NO_PROXY", "value": SANDBOX_NO_PROXY},
        {"name": "no_proxy", "value": SANDBOX_NO_PROXY},
    ]
    if any(entry["name"] in _RESERVED_FORBIDDEN_ENV for entry in env_list):
        raise ValueError(f"{K8S_MANIFEST_INVARIANT_ERROR}: virgin template cannot carry tenant env")

    pod_spec: dict[str, Any] = {
        "runtimeClassName": runtime_class,
        "automountServiceAccountToken": False,
        "restartPolicy": "Never",
        "securityContext": {
            "runAsNonRoot": True,
            "runAsUser": DEFAULT_SANDBOX_UID,
            "runAsGroup": DEFAULT_SANDBOX_UID,
            "fsGroup": DEFAULT_SANDBOX_UID,
            "seccompProfile": {"type": "RuntimeDefault"},
        },
        "containers": [
            {
                "name": "sandbox",
                "image": clean_image,
                "command": entrypoint,
                "ports": [{"name": "http", "containerPort": 8080, "protocol": "TCP"}],
                "env": env_list,
                "readinessProbe": {
                    "httpGet": {"path": "/health", "port": 8080},
                    "initialDelaySeconds": 1,
                    "periodSeconds": 5,
                },
                "resources": {
                    "requests": {"cpu": f"{cpu_millis}m", "memory": memory_limit},
                    "limits": {"cpu": f"{cpu_millis}m", "memory": memory_limit},
                },
                "securityContext": {
                    "allowPrivilegeEscalation": False,
                    "readOnlyRootFilesystem": True,
                    "runAsNonRoot": True,
                    "runAsUser": DEFAULT_SANDBOX_UID,
                    "capabilities": {"drop": ["ALL"]},
                },
                "volumeMounts": [
                    {"name": "workspace-nvme", "mountPath": "/workspace"},
                    {"name": "runtime-tmp", "mountPath": "/run/hussh-tmp"},
                    {"name": "gunicorn-runtime", "mountPath": "/app/.gunicorn"},
                ],
            }
        ],
        "volumes": [
            {
                "name": "workspace-nvme",
                "emptyDir": {"sizeLimit": "4Gi"},
            },
            {
                "name": "runtime-tmp",
                "emptyDir": {"medium": "Memory", "sizeLimit": "256Mi"},
            },
            {
                "name": "gunicorn-runtime",
                "emptyDir": {"medium": "Memory", "sizeLimit": "64Mi"},
            },
        ],
    }
    if host_aliases is not None:
        pod_spec["hostAliases"] = host_aliases

    return {
        "apiVersion": AGENT_SANDBOX_EXTENSIONS_API_VERSION,
        "kind": "SandboxTemplate",
        "metadata": {
            "name": tpl_name,
            "namespace": ns,
            "labels": {
                "app.kubernetes.io/part-of": "hussh-one",
                "hussh.ai/sanitization-mode": "single-use-destroy",
                "hussh.ai/compliance-profile": "fedramp-high-baseline",
            },
        },
        "spec": {
            "envVarsInjectionPolicy": "Disallowed",
            "volumeClaimTemplatesPolicy": "Disallowed",
            "failedPodPolicy": "Retain",
            "networkPolicyManagement": "Unmanaged",
            "podTemplate": {
                "metadata": {
                    "labels": {
                        "app": "hussh-one-sandbox",
                        "hussh.ai/pool": tpl_name,
                        "hussh.ai/egress-enforced": "sentinel",
                    }
                },
                "spec": pod_spec,
            },
        },
    }


def render_sandbox_warm_pool(
    *,
    name: str = "hussh-one-warm-pool",
    namespace: str = "hussh-agents",
    template_name: str = "hussh-one-sandbox-v1",
    replicas: int = 1,
) -> dict[str, Any]:
    """Render a virgin pre-warmed v1beta1 SandboxWarmPool sized for active demand."""
    pool_name = _require_dns_label(name, field_name="warm pool name")
    ns = _require_dns_label(namespace, field_name="namespace")
    tpl_name = _require_dns_label(template_name, field_name="template name")
    if replicas < 0 or replicas > 5000:
        raise ValueError(f"{K8S_MANIFEST_INVARIANT_ERROR}: replicas out of bounds")
    return {
        "apiVersion": AGENT_SANDBOX_EXTENSIONS_API_VERSION,
        "kind": "SandboxWarmPool",
        "metadata": {"name": pool_name, "namespace": ns},
        "spec": {
            "replicas": replicas,
            "sandboxTemplateRef": {"name": tpl_name},
            "updateStrategy": {"type": "Recreate"},
        },
    }


def render_sandbox_claim(
    *,
    claim_name: str,
    namespace: str = "hussh-agents",
    warm_pool_name: str = "hussh-one-warm-pool",
    billing_space_id: str,
    idle_shutdown_seconds: int = 600,
    now_epoch_s: int | None = None,
) -> dict[str, Any]:
    """Render an ephemeral single-use v1beta1 SandboxClaim (`DeleteForeground`, NIST SC-4)."""
    clean_claim = _require_dns_label(claim_name, field_name="claim name")
    ns = _require_dns_label(namespace, field_name="namespace")
    pool_name = _require_dns_label(warm_pool_name, field_name="warm pool name")
    clean_space = re.sub(r"[^a-z0-9_-]+", "-", str(billing_space_id or "").strip().lower()).strip(
        "-_"
    )
    if not clean_space or len(clean_space) > 63:
        raise ValueError(f"{K8S_MANIFEST_INVARIANT_ERROR}: valid billing_space_id required")
    if idle_shutdown_seconds < 60 or idle_shutdown_seconds > 3600:
        raise ValueError(f"{K8S_MANIFEST_INVARIANT_ERROR}: idle_shutdown_seconds out of bounds")
    base_epoch = int(time.time()) if now_epoch_s is None else int(now_epoch_s)
    shutdown_dt = datetime.datetime.fromtimestamp(
        base_epoch + idle_shutdown_seconds, tz=datetime.timezone.utc
    )
    shutdown_iso = shutdown_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "apiVersion": AGENT_SANDBOX_EXTENSIONS_API_VERSION,
        "kind": "SandboxClaim",
        "metadata": {
            "name": clean_claim,
            "namespace": ns,
            "labels": {
                "hussh-billing-space": clean_space,
                "hussh.ai/single-use": "true",
            },
        },
        "spec": {
            "warmPoolRef": {"name": pool_name},
            "additionalPodMetadata": {
                "labels": {
                    "sandbox.users.io/billing-space": clean_space,
                    "sandbox.users.io/single-use": "true",
                }
            },
            "lifecycle": {
                "shutdownPolicy": "DeleteForeground",
                "ttlSecondsAfterFinished": 0,
                "shutdownTime": shutdown_iso,
            },
        },
    }


def render_sandbox_network_policy(
    *,
    name: str = "hussh-one-sandbox-egress-fence",
    namespace: str = "hussh-agents",
    hub_namespace: str = "hussh-hub-router",
    proxy_namespace: str = "hussh-sandbox-system",
    proxy_port: int = DEFAULT_EGRESS_PROXY_PORT,
    model_gateway_port: int = DEFAULT_MODEL_GATEWAY_PORT,
    edge_vpc_cidr: str | None = None,
) -> dict[str, Any]:
    """Render default-deny Ingress/Egress NetworkPolicy (NIST SC-7(5))."""
    policy_name = _require_dns_label(name, field_name="policy name")
    ns = _require_dns_label(namespace, field_name="namespace")
    hub_ns = _require_dns_label(hub_namespace, field_name="hub namespace")
    proxy_ns = _require_dns_label(proxy_namespace, field_name="proxy namespace")
    if not 1 <= proxy_port <= 65535 or not 1 <= model_gateway_port <= 65535:
        raise ValueError(f"{K8S_MANIFEST_INVARIANT_ERROR}: proxy_port out of range")
    ingress_from: list[dict[str, Any]] = [
        {
            "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": hub_ns}},
            "podSelector": {"matchLabels": {"app": "hussh-consent-hub"}},
        }
    ]
    if edge_vpc_cidr is not None:
        try:
            net = ipaddress.ip_network(str(edge_vpc_cidr).strip(), strict=False)
        except ValueError as exc:
            raise ValueError(
                f"{K8S_MANIFEST_INVARIANT_ERROR}: valid edge_vpc_cidr required"
            ) from exc
        ingress_from.append({"ipBlock": {"cidr": str(net)}})
    return {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": {"name": policy_name, "namespace": ns},
        "spec": {
            "podSelector": {"matchLabels": {"app": "hussh-one-sandbox"}},
            "policyTypes": ["Ingress", "Egress"],
            "ingress": [
                {
                    "from": ingress_from,
                    "ports": [{"protocol": "TCP", "port": 8080}],
                }
            ],
            "egress": [
                {
                    "to": [
                        {
                            "namespaceSelector": {
                                "matchLabels": {"kubernetes.io/metadata.name": proxy_ns}
                            },
                            "podSelector": {"matchLabels": {"app": "sentinel-egress-proxy"}},
                        }
                    ],
                    "ports": [
                        {"protocol": "TCP", "port": proxy_port},
                        {"protocol": "TCP", "port": model_gateway_port},
                    ],
                },
                {
                    "to": [
                        {
                            "namespaceSelector": {
                                "matchLabels": {"kubernetes.io/metadata.name": "kube-system"}
                            }
                        },
                        {"ipBlock": {"cidr": "169.254.20.10/32"}},
                    ],
                    "ports": [
                        {"protocol": "UDP", "port": 53},
                        {"protocol": "TCP", "port": 53},
                    ],
                },
            ],
        },
    }


def render_agent_sandbox_bundle(
    *,
    claim_name: str,
    billing_space_id: str,
    image_ref: str,
    namespace: str = "hussh-agents",
    runtime_class: SandboxRuntimeClass = "microvm",
    warm_pool_replicas: int = 1,
    warm_pool_name: str = "hussh-one-warm-pool",
) -> dict[str, dict[str, Any]]:
    """Render complete portable Kubernetes AgentSandbox v1beta1 resources for one claim."""
    return {
        "template": render_sandbox_template(
            namespace=namespace,
            image_ref=image_ref,
            runtime_class=runtime_class,
        ),
        "warmPool": render_sandbox_warm_pool(
            name=warm_pool_name,
            namespace=namespace,
            replicas=warm_pool_replicas,
        ),
        "networkPolicy": render_sandbox_network_policy(namespace=namespace),
        "claim": render_sandbox_claim(
            claim_name=claim_name,
            namespace=namespace,
            warm_pool_name=warm_pool_name,
            billing_space_id=billing_space_id,
        ),
    }
