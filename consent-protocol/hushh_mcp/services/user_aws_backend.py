# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Owner-account AWS ECS Fargate compute adapter (`user_aws`, plan-mode foundation).

Renders a deterministic ECS Fargate task + internal/HTTPS-locked service definition in
the owner's AWS account using:
- S3 conditional commit-log storage (`POD_STORAGE_S3_URI`);
- AWS KMS DEK custody (`HUSSH_POD_AWS_KMS_KEY_ARN`) or `ace_envelope` custody;
- ECS task IAM role (`taskRoleArn`) with zero long-lived access keys;
- Secrets Manager reference (`valueFrom`) for `APP_SIGNING_KEY` — never inline;
- Internal ALB / hub-caller ingress lock (`HUSSH_POD_HUB_CALLER_EMAILS`).

Live AWS STS/ECS mutation fails closed until AWS federation admission is enabled.
"""

from __future__ import annotations

import os
import re
from typing import Any

from hushh_mcp.services.byoc_key_custody import (
    WRAPPED_KEY_OBJECT_ENV,
    WRAPPED_LOG_KEY_OBJECT,
)
from hushh_mcp.services.compute_backend import (
    BACKEND_USER_AWS,
    CUSTODY_ACE_ENVELOPE,
    POD_CPU_MILLIS,
    POD_MEMORY,
    POD_REQUEST_CONCURRENCY,
    BackendHandle,
    BackendStatus,
    PodSpec,
    effective_custody_mode,
)
from hushh_mcp.services.pod_common_env import merge_pod_env, shared_non_gcp_pod_env

_ACCOUNT_ID_RE = re.compile(r"^[0-9]{12}$")
_PLACEHOLDER_DIGEST = "sha256:" + "0" * 64


def _slug(hushh_id: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", hushh_id.lower()).strip("-")
    return (cleaned or "agent")[:28]


def _memory_mib(memory: str) -> str:
    text = memory.strip()
    if text.endswith("Gi"):
        return str(int(text[:-2]) * 1024)
    if text.endswith("Mi"):
        return str(int(text[:-2]))
    return "2048"


class UserAwsBackend:
    """Per-owner AWS ECS Fargate adapter (`ComputeBackend` protocol)."""

    backend_id = BACKEND_USER_AWS

    def __init__(
        self,
        *,
        account_id: str,
        region: str,
        role_arn: str,
        image_digest: str = "",
        live: bool = False,
    ) -> None:
        acct = str(account_id or "").strip()
        reg = str(region or "").strip()
        role = str(role_arn or "").strip()
        if not _ACCOUNT_ID_RE.fullmatch(acct):
            raise ValueError("user_aws account_id must be a 12-digit AWS account id")
        if not reg:
            raise ValueError("user_aws region is required")
        if not role.startswith(f"arn:aws:iam::{acct}:role/"):
            raise ValueError("user_aws role_arn must belong to the owner's AWS account")
        self._account_id = acct
        self._region = reg
        self._role_arn = role
        self._image_digest = image_digest.strip() or _PLACEHOLDER_DIGEST
        self._live = live

    async def provision(self, spec: PodSpec) -> BackendHandle:
        if self._live:
            raise NotImplementedError("live user_aws STS provisioning is not yet enabled")
        from hushh_mcp.services.gcp_backend import A2A_ADDRESS_BASE  # noqa: PLC0415

        rendered = self.render_deploy_config(spec)
        family = rendered["taskDefinition"]["family"]
        return BackendHandle(
            external_agent_id=f"arn:aws:ecs:{self._region}:{self._account_id}:service/hussh-one/{family}",
            a2a_route=f"{A2A_ADDRESS_BASE}/{spec.hushh_id}",
            status="planned",
            backend=BACKEND_USER_AWS,
            backend_metadata={
                "tenancy": "user-owned",
                "accountId": self._account_id,
                "region": self._region,
                "roleArn": self._role_arn,
                "hostKind": "aws_fargate",
                "custodyMode": effective_custody_mode(spec),
            },
        )

    async def deprovision(self, external_agent_id: str) -> None:
        if self._live:
            raise NotImplementedError("user_aws uses owner-access erasure, never delete authority")
        return None

    async def get(self, external_agent_id: str) -> BackendStatus:
        return BackendStatus(
            external_agent_id=(external_agent_id or None),
            status="planned",
            healthy=False,
        )

    async def health(self) -> bool:
        return True

    def render_deploy_config(self, spec: PodSpec) -> dict[str, Any]:
        hub_caller = (os.getenv("HUSSH_CONSENT_PLANE_SA") or "").strip()
        if not hub_caller:
            raise ValueError("the in-pod wall needs HUSSH_CONSENT_PLANE_SA; refusing a public pod")
        slug = _slug(spec.hushh_id)
        family = f"hussh-one-{slug}"
        bucket = f"hussh-one-{self._account_id}-{slug}"
        kms_arn = f"arn:aws:kms:{self._region}:{self._account_id}:key/alias/{family}-custody"
        signing_secret_arn = f"arn:aws:secretsmanager:{self._region}:{self._account_id}:secret:{family}/app-signing-key"
        custody = effective_custody_mode(spec)
        custody_env: list[dict[str, str]]
        if custody == CUSTODY_ACE_ENVELOPE:
            custody_env = [{"name": "HUSSH_POD_CUSTODY_MODE", "value": CUSTODY_ACE_ENVELOPE}]
        else:
            custody_env = [
                {"name": "HUSSH_POD_CUSTODY_MODE", "value": custody},
                {"name": "HUSSH_POD_AWS_KMS_KEY_ARN", "value": kms_arn},
                {"name": WRAPPED_KEY_OBJECT_ENV, "value": WRAPPED_LOG_KEY_OBJECT},
            ]

        aws_overrides: list[dict[str, str]] = [
            {"name": "POD_STORAGE_BACKEND", "value": "commit_log"},
            {"name": "POD_STORAGE_S3_URI", "value": f"s3://{bucket}/pod"},
            *custody_env,
            {"name": "POD_DURABLE_IDENTITY_ENABLED", "value": "true"},
            {"name": "POD_AGENT_MEMORY_ENABLED", "value": "true"},
            {"name": "GOOGLE_GENAI_USE_VERTEXAI", "value": "false"},
            {"name": "HUSSH_POD_HUB_CALLER_EMAILS", "value": hub_caller},
            {"name": "HUSSH_AWS_SERVICE_NAME", "value": family},
            {"name": "POD_IDLE_GRACE_SECONDS", "value": "600"},
        ]
        env = merge_pod_env(shared_non_gcp_pod_env(spec, self._region), aws_overrides)
        image = (
            f"{self._account_id}.dkr.ecr.{self._region}.amazonaws.com/"
            f"consent-protocol-pod@{self._image_digest}"
        )
        return {
            "platform": "aws_ecs_fargate",
            "accountId": self._account_id,
            "region": self._region,
            "ingress": {
                "internalOnly": True,
                "protocol": "HTTPS",
                "allowInsecureHttp": False,
                "maxConcurrency": POD_REQUEST_CONCURRENCY,
            },
            "taskDefinition": {
                "family": family,
                "networkMode": "awsvpc",
                "requiresCompatibilities": ["FARGATE"],
                "cpu": str(POD_CPU_MILLIS),
                "memory": _memory_mib(POD_MEMORY),
                "taskRoleArn": self._role_arn,
                "executionRoleArn": self._role_arn,
                "containerDefinitions": [
                    {
                        "name": "pod",
                        "image": image,
                        "essential": True,
                        "portMappings": [{"containerPort": 8080, "protocol": "tcp"}],
                        "environment": env,
                        "secrets": [
                            {
                                "name": "APP_SIGNING_KEY",
                                "valueFrom": signing_secret_arn,
                            }
                        ],
                        "healthCheck": {
                            "command": [
                                "CMD-SHELL",
                                "curl -fsS http://127.0.0.1:8080/health || exit 1",
                            ],
                            "interval": 30,
                            "timeout": 5,
                            "retries": 3,
                        },
                    }
                ],
            },
            "service": {
                "serviceName": family,
                "desiredCount": 0,
                "maxCount": 1,
                "launchType": "FARGATE",
            },
        }
