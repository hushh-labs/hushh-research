# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Deterministic owner-account AWS setup blueprint, IAM boundaries, and Floci readiness gate.

Mirrors the sovereign BYOC trust matrix established in ``azure_setup_plan.py`` and
``azure_agent_erasure.py``:
- Setup creates resources once inside the owner's AWS account (CloudFormation blueprint).
- Cryptographic owner-binding tags (``hussh-tenancy``, ``hussh-setup-nonce``,
  ``hussh-setup-binding``, ``hussh-incarnation``) close the confused-deputy gap on
  every subsequent federated read, restart, and access revocation.
- Hussh's federated IAM role holds ONLY ``HusshObserverAccess`` (describe/restart ECS,
  inspect role policies) and ``HusshRemovalAccess`` (disable KMS key, delete pod and
  Hussh inline policies). It NEVER holds ``s3:DeleteBucket``, ``s3:GetObject``,
  ``ecs:DeleteService``, ``kms:Decrypt``, ``kms:ScheduleKeyDeletion``, or
  ``secretsmanager:GetSecretValue``.
- Live control-plane readiness probes and adapter calls are strictly gated to loopback
  Floci (``FLOCI_ENDPOINT_URL``) in ``dev``/``test`` while ``execution_qualified`` is
  ``False`` in ``PROVIDER_CAPABILITY_REGISTRY``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from hushh_mcp.services.compute_backend import (
    BACKEND_USER_AWS,
    CUSTODY_ACE_ENVELOPE,
    CUSTODY_OWNER_KMS,
    POD_CPU_MILLIS,
    POD_MEMORY,
    PodSpec,
    effective_custody_mode,
    owner_cloud_coordinates_complete,
)

TENANCY_TAG = "hussh-tenancy"
NONCE_TAG = "hussh-setup-nonce"
BINDING_TAG = "hussh-setup-binding"
INCARNATION_TAG = "hussh-incarnation"
POD_ENDPOINT_TAG = "hussh-pod-url"

POD_RUNTIME_POLICY_NAME = "HusshPodRuntimeAccess"
OBSERVER_POLICY_NAME = "HusshObserverAccess"
REMOVAL_POLICY_NAME = "HusshRemovalAccess"

KMS_MIN_PENDING_WINDOW_DAYS = 7
AWS_RECEIPT_VERSION = 1

_ACCOUNT_ID_RE = re.compile(r"^[0-9]{12}$")
_NONCE_RE = re.compile(r"^[0-9a-f]{16}$")
_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_PLACEHOLDER_DIGEST = "sha256:" + "0" * 64
_SEPARATOR = "\x1f"
_FORBIDDEN_FLOCI_ENVS = frozenset({"production", "prod", "uat", "staging"})
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


class AwsFlociGateRefused(RuntimeError):
    """Live AWS readiness or adapter calls attempted outside the dev/test Floci boundary."""


def aws_pod_slug(hushh_id: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", str(hushh_id or "").lower()).strip("-")
    return (cleaned or "agent")[:28]


def _signing_master_key() -> bytes:
    from hushh_mcp.runtime_settings import get_core_security_settings  # noqa: PLC0415

    key = (get_core_security_settings().app_signing_key or "").strip()
    if not key:
        raise RuntimeError("APP_SIGNING_KEY is required for AWS setup owner-binding digests")
    return key.encode("utf-8")


def aws_keyed_digest(label: str, *parts: str) -> str:
    """Domain-separated HMAC-SHA256 hex digest under ``APP_SIGNING_KEY``."""
    if not label or any(_SEPARATOR in str(part) for part in parts):
        raise ValueError("AWS keyed digest parts may not contain the unit separator")
    derived = hmac.new(
        _signing_master_key(),
        f"hussh/aws/{label}/v1".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    message = _SEPARATOR.join(str(part) for part in parts).encode("utf-8")
    return hmac.new(derived, message, hashlib.sha256).hexdigest()


def aws_digest_matches(expected_hex: str, label: str, *parts: str) -> bool:
    """Constant-time verification of a previously minted AWS setup digest."""
    return hmac.compare_digest(str(expected_hex or ""), aws_keyed_digest(label, *parts))


def aws_setup_binding(hushh_id: str, account_id: str, region: str, nonce: str) -> str:
    return aws_keyed_digest("setup-binding", hushh_id, account_id, region, nonce)


def aws_binding_is_valid(
    tag_map: Any,
    *,
    hushh_id: str,
    account_id: str,
    region: str,
) -> bool:
    """True only when resource tags carry a valid cryptographic owner-binding for this pod."""
    tags = tag_map if isinstance(tag_map, dict) else {}
    if tags.get(TENANCY_TAG) != "user-owned":
        return False
    nonce = str(tags.get(NONCE_TAG) or "").strip()
    if not _NONCE_RE.fullmatch(nonce):
        return False
    return aws_digest_matches(
        str(tags.get(BINDING_TAG) or ""),
        "setup-binding",
        hushh_id,
        account_id,
        region,
        nonce,
    )


def require_floci_only_aws_readiness_endpoint() -> str:
    """Enforce Floci-only loopback execution in dev/test while live AWS is unqualified.

    Refuses:
    1. Any call in ``uat``, ``staging``, ``prod``, or ``production``;
    2. Any call without ``FLOCI_ENDPOINT_URL`` when ``user_aws`` ``execution_qualified``
       is ``False`` (preventing accidental traffic to ``*.amazonaws.com``);
    3. Any ``FLOCI_ENDPOINT_URL`` that is not loopback ``http://`` or ``https://``.
    """
    from hushh_mcp.services.pod_s3_object_store import FLOCI_ENDPOINT_URL_ENV  # noqa: PLC0415
    from hushh_mcp.services.provider_capability_registry import (  # noqa: PLC0415
        PROVIDER_CAPABILITY_REGISTRY,
    )

    deploy_env = (
        (os.getenv("HUSHH_DEPLOY_ENV") or os.getenv("ENVIRONMENT") or os.getenv("APP_ENV") or "")
        .strip()
        .lower()
    )
    if deploy_env in _FORBIDDEN_FLOCI_ENVS:
        raise AwsFlociGateRefused(
            "live user_aws readiness and control-plane execution are refused in UAT and production"
        )

    floci_url = (os.getenv(FLOCI_ENDPOINT_URL_ENV) or "").strip()
    aws_spec = PROVIDER_CAPABILITY_REGISTRY[BACKEND_USER_AWS]
    if not aws_spec.sandbox_capability.execution_qualified and not floci_url:
        raise AwsFlociGateRefused(
            "AWS readiness is currently restricted to Floci loopback rehearsal "
            f"({FLOCI_ENDPOINT_URL_ENV} required while execution_qualified is False)"
        )

    if floci_url:
        parsed = urllib.parse.urlsplit(floci_url)
        host = (parsed.hostname or "").strip().lower()
        if parsed.scheme not in {"http", "https"} or host not in _LOOPBACK_HOSTS:
            raise AwsFlociGateRefused(
                "FLOCI_ENDPOINT_URL for AWS readiness rehearsal must bind strictly to loopback"
            )
    return floci_url


@dataclass(frozen=True)
class AwsPlanInputs:
    hushh_id: str
    account_id: str
    region: str
    nonce: str
    image_digest: str
    incarnation: str = ""
    pod_url: str = ""
    hub_oidc_issuer: str = "accounts.google.com"
    hub_caller_subject: str = ""
    custody_mode: str = CUSTODY_OWNER_KMS

    def __post_init__(self) -> None:
        if not _ACCOUNT_ID_RE.fullmatch(self.account_id):
            raise ValueError("AWS setup plan requires a 12-digit account_id")
        if not str(self.region or "").strip():
            raise ValueError("AWS setup plan requires a non-empty region")
        if not _NONCE_RE.fullmatch(self.nonce):
            raise ValueError("AWS setup plan requires a 16-char lowercase hex setup nonce")
        if not _DIGEST_RE.fullmatch(self.image_digest) or self.image_digest == _PLACEHOLDER_DIGEST:
            raise ValueError("AWS setup plan requires a non-placeholder sha256 image digest")
        if self.custody_mode not in {CUSTODY_OWNER_KMS, CUSTODY_ACE_ENVELOPE}:
            raise ValueError(f"unsupported user_aws custody_mode: {self.custody_mode}")

    @property
    def resolved_incarnation(self) -> str:
        return (
            self.incarnation.strip()
            or aws_keyed_digest("incarnation", self.hushh_id, self.nonce)[:32]
        )

    @property
    def resolved_pod_url(self) -> str:
        if self.pod_url.strip():
            return self.pod_url.strip().rstrip("/")
        slug = aws_pod_slug(self.hushh_id)
        return f"https://hussh-one-{slug}.{self.region}.aws.internal"


@dataclass(frozen=True)
class AwsResourceNames:
    stack_name: str
    cluster_name: str
    service_name: str
    task_family: str
    bucket_name: str
    kms_alias: str
    signing_secret_name: str
    pod_task_role_name: str
    observer_role_name: str
    cluster_arn: str
    service_arn: str
    bucket_arn: str
    kms_alias_arn: str
    signing_secret_arn: str
    pod_task_role_arn: str
    observer_role_arn: str


def aws_resource_names(
    *,
    hushh_id: str,
    account_id: str,
    region: str,
    observer_role_arn_override: str = "",
) -> AwsResourceNames:
    slug = aws_pod_slug(hushh_id)
    family = f"hussh-one-{slug}"
    cluster = "hussh-one"
    bucket = f"hussh-one-{account_id}-{slug}"
    kms_alias = f"alias/{family}-custody"
    secret_name = f"{family}/app-signing-key"
    pod_role = f"{family}-pod-role"
    if observer_role_arn_override.startswith(f"arn:aws:iam::{account_id}:role/"):
        obs_arn = observer_role_arn_override
        obs_role = obs_arn.split(":role/", 1)[1].rsplit("/", 1)[-1]
    else:
        obs_role = f"{family}-observer-role"
        obs_arn = f"arn:aws:iam::{account_id}:role/{obs_role}"
    return AwsResourceNames(
        stack_name=family,
        cluster_name=cluster,
        service_name=family,
        task_family=family,
        bucket_name=bucket,
        kms_alias=kms_alias,
        signing_secret_name=secret_name,
        pod_task_role_name=pod_role,
        observer_role_name=obs_role,
        cluster_arn=f"arn:aws:ecs:{region}:{account_id}:cluster/{cluster}",
        service_arn=f"arn:aws:ecs:{region}:{account_id}:service/{cluster}/{family}",
        bucket_arn=f"arn:aws:s3:::{bucket}",
        kms_alias_arn=f"arn:aws:kms:{region}:{account_id}:{kms_alias}",
        signing_secret_arn=f"arn:aws:secretsmanager:{region}:{account_id}:secret:{secret_name}",
        pod_task_role_arn=f"arn:aws:iam::{account_id}:role/{pod_role}",
        observer_role_arn=obs_arn,
    )


def aws_owner_tags(inputs: AwsPlanInputs) -> dict[str, str]:
    return {
        TENANCY_TAG: "user-owned",
        NONCE_TAG: inputs.nonce,
        BINDING_TAG: aws_setup_binding(
            inputs.hushh_id, inputs.account_id, inputs.region, inputs.nonce
        ),
        INCARNATION_TAG: inputs.resolved_incarnation,
        POD_ENDPOINT_TAG: inputs.resolved_pod_url,
    }


def pod_runtime_policy_document(
    inputs: AwsPlanInputs,
    names: AwsResourceNames,
    *,
    kms_key_arn: str | None = None,
) -> dict[str, Any]:
    """Least-privilege inline policy for the pod ECS task role (zero wildcard resources)."""
    statements: list[dict[str, Any]] = [
        {
            "Sid": "PodCommitLogObjectAccess",
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
            ],
            "Resource": [f"{names.bucket_arn}/pod/*"],
        },
        {
            "Sid": "PodBucketPrefixList",
            "Effect": "Allow",
            "Action": ["s3:ListBucket"],
            "Resource": [names.bucket_arn],
        },
        {
            "Sid": "PodSigningSecretRead",
            "Effect": "Allow",
            "Action": ["secretsmanager:GetSecretValue"],
            "Resource": [f"{names.signing_secret_arn}*"],
        },
    ]
    if inputs.custody_mode == CUSTODY_OWNER_KMS:
        key_resource = kms_key_arn or f"arn:aws:kms:{inputs.region}:{inputs.account_id}:key/*"
        statements.append(
            {
                "Sid": "PodCustodyKeyEnvelope",
                "Effect": "Allow",
                "Action": [
                    "kms:Encrypt",
                    "kms:Decrypt",
                    "kms:DescribeKey",
                ],
                "Resource": [key_resource],
            }
        )
    return {"Version": "2012-10-17", "Statement": statements}


def hussh_observer_policy_document(
    inputs: AwsPlanInputs,
    names: AwsResourceNames,
) -> dict[str, Any]:
    """Standing federated observer permissions: read + in-place restart ONLY (zero delete)."""
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "ObserveAndRestartPodService",
                "Effect": "Allow",
                "Action": [
                    "ecs:DescribeServices",
                    "ecs:UpdateService",
                    "ecs:ListTagsForResource",
                ],
                "Resource": [names.service_arn],
            },
            {
                "Sid": "InspectTaskDefinitionsAndRolePolicies",
                "Effect": "Allow",
                "Action": [
                    "ecs:DescribeTaskDefinition",
                    "iam:GetRole",
                    "iam:ListRolePolicies",
                ],
                "Resource": [
                    f"arn:aws:ecs:{inputs.region}:{inputs.account_id}:task-definition/{names.task_family}:*",
                    names.pod_task_role_arn,
                    names.observer_role_arn,
                ],
            },
        ],
    }


def hussh_removal_policy_document(
    inputs: AwsPlanInputs,
    names: AwsResourceNames,
    *,
    kms_key_arn: str | None = None,
) -> dict[str, Any]:
    """Self-revoking access removal permissions (zero resource/bucket/key deletion)."""
    key_target = kms_key_arn or names.kms_alias_arn
    statements: list[dict[str, Any]] = [
        {
            "Sid": "ScalePodServiceToZeroDuringRevocation",
            "Effect": "Allow",
            "Action": ["ecs:UpdateService"],
            "Resource": [names.service_arn],
        },
        {
            "Sid": "RevokePodAndHusshInlinePolicies",
            "Effect": "Allow",
            "Action": ["iam:DeleteRolePolicy"],
            "Resource": [
                names.pod_task_role_arn,
                names.observer_role_arn,
            ],
        },
    ]
    if inputs.custody_mode == CUSTODY_OWNER_KMS:
        statements.append(
            {
                "Sid": "DisableOwnerCustodyKeyWithoutSchedulingDeletion",
                "Effect": "Allow",
                "Action": [
                    "kms:DescribeKey",
                    "kms:DisableKey",
                ],
                "Resource": [
                    key_target,
                    f"arn:aws:kms:{inputs.region}:{inputs.account_id}:key/*",
                ],
            }
        )
    return {"Version": "2012-10-17", "Statement": statements}


def render_cloudformation_template(
    inputs: AwsPlanInputs,
    *,
    task_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Render a deterministic CloudFormation stack blueprint for an owner AWS pod."""
    names = aws_resource_names(
        hushh_id=inputs.hushh_id,
        account_id=inputs.account_id,
        region=inputs.region,
    )
    tag_map = aws_owner_tags(inputs)
    cfn_tags = [{"Key": k, "Value": v} for k, v in sorted(tag_map.items())]

    memory_mib = "2048"
    mem_text = POD_MEMORY.strip()
    if mem_text.endswith("Gi"):
        memory_mib = str(int(mem_text[:-2]) * 1024)
    elif mem_text.endswith("Mi"):
        memory_mib = str(int(mem_text[:-2]))

    image = (
        f"{inputs.account_id}.dkr.ecr.{inputs.region}.amazonaws.com/"
        f"consent-protocol-pod@{inputs.image_digest}"
    )
    container_defs = (
        task_config["taskDefinition"]["containerDefinitions"]
        if task_config is not None
        else [
            {
                "Name": "pod",
                "Image": image,
                "Essential": True,
                "PortMappings": [{"ContainerPort": 8080, "Protocol": "tcp"}],
            }
        ]
    )

    resources: dict[str, Any] = {
        "PodStorageBucket": {
            "Type": "AWS::S3::Bucket",
            "DeletionPolicy": "Retain",
            "UpdateReplacePolicy": "Retain",
            "Properties": {
                "BucketName": names.bucket_name,
                "PublicAccessBlockConfiguration": {
                    "BlockPublicAcls": True,
                    "BlockPublicPolicy": True,
                    "IgnorePublicAcls": True,
                    "RestrictPublicBuckets": True,
                },
                "VersioningConfiguration": {"Status": "Enabled"},
                "BucketEncryption": {
                    "ServerSideEncryptionConfiguration": [
                        {"ServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}
                    ]
                },
                "Tags": cfn_tags,
            },
        },
        "PodSigningSecret": {
            "Type": "AWS::SecretsManager::Secret",
            "DeletionPolicy": "Retain",
            "Properties": {
                "Name": names.signing_secret_name,
                "GenerateSecretString": {"PasswordLength": 64, "ExcludePunctuation": True},
                "Tags": cfn_tags,
            },
        },
        "PodTaskRole": {
            "Type": "AWS::IAM::Role",
            "Properties": {
                "RoleName": names.pod_task_role_name,
                "AssumeRolePolicyDocument": {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Effect": "Allow",
                            "Principal": {"Service": "ecs-tasks.amazonaws.com"},
                            "Action": "sts:AssumeRole",
                        }
                    ],
                },
                "Policies": [
                    {
                        "PolicyName": POD_RUNTIME_POLICY_NAME,
                        "PolicyDocument": pod_runtime_policy_document(inputs, names),
                    }
                ],
                "Tags": cfn_tags,
            },
        },
        "HusshObserverRole": {
            "Type": "AWS::IAM::Role",
            "Properties": {
                "RoleName": names.observer_role_name,
                "AssumeRolePolicyDocument": {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Effect": "Allow",
                            "Principal": {
                                "Federated": (
                                    f"arn:aws:iam::{inputs.account_id}:oidc-provider/"
                                    f"{inputs.hub_oidc_issuer}"
                                )
                            },
                            "Action": "sts:AssumeRoleWithWebIdentity",
                            "Condition": {
                                "StringEquals": {"sts:ExternalId": inputs.nonce},
                            },
                        }
                    ],
                },
                "Policies": [
                    {
                        "PolicyName": OBSERVER_POLICY_NAME,
                        "PolicyDocument": hussh_observer_policy_document(inputs, names),
                    },
                    {
                        "PolicyName": REMOVAL_POLICY_NAME,
                        "PolicyDocument": hussh_removal_policy_document(inputs, names),
                    },
                ],
                "Tags": cfn_tags,
            },
        },
        "PodCluster": {
            "Type": "AWS::ECS::Cluster",
            "Properties": {
                "ClusterName": names.cluster_name,
                "Tags": cfn_tags,
            },
        },
        "PodTaskDefinition": {
            "Type": "AWS::ECS::TaskDefinition",
            "Properties": {
                "Family": names.task_family,
                "NetworkMode": "awsvpc",
                "RequiresCompatibilities": ["FARGATE"],
                "Cpu": str(POD_CPU_MILLIS),
                "Memory": memory_mib,
                "TaskRoleArn": names.pod_task_role_arn,
                "ExecutionRoleArn": names.pod_task_role_arn,
                "ContainerDefinitions": json.loads(json.dumps(container_defs)),
                "Tags": cfn_tags,
            },
        },
        "PodService": {
            "Type": "AWS::ECS::Service",
            "DependsOn": ["PodCluster", "PodTaskDefinition"],
            "Properties": {
                "ServiceName": names.service_name,
                "Cluster": names.cluster_name,
                "TaskDefinition": {"Ref": "PodTaskDefinition"},
                "DesiredCount": 0,
                "LaunchType": "FARGATE",
                "DeploymentConfiguration": {
                    "MaximumPercent": 100,
                    "MinimumHealthyPercent": 0,
                },
                "EnableECSManagedTags": True,
                "PropagateTags": "SERVICE",
                "Tags": cfn_tags,
            },
        },
    }

    if inputs.custody_mode == CUSTODY_OWNER_KMS:
        resources["PodCustodyKey"] = {
            "Type": "AWS::KMS::Key",
            "DeletionPolicy": "Retain",
            "UpdateReplacePolicy": "Retain",
            "Properties": {
                "Description": f"Hussh One sovereign pod custody key ({names.stack_name})",
                "EnableKeyRotation": True,
                "PendingWindowInDays": KMS_MIN_PENDING_WINDOW_DAYS,
                "KeyPolicy": {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Sid": "OwnerAccountRootAdministration",
                            "Effect": "Allow",
                            "Principal": {"AWS": f"arn:aws:iam::{inputs.account_id}:root"},
                            "Action": "kms:*",
                            "Resource": "*",
                        }
                    ],
                },
                "Tags": cfn_tags,
            },
        }
        resources["PodCustodyKeyAlias"] = {
            "Type": "AWS::KMS::Alias",
            "Properties": {
                "AliasName": names.kms_alias,
                "TargetKeyId": {"Ref": "PodCustodyKey"},
            },
        }

    return {
        "AWSTemplateFormatVersion": "2010-09-09",
        "Description": (
            "Hussh One owner-account AWS ECS Fargate sovereign pod stack "
            "(zero Hussh delete authority)"
        ),
        "Resources": resources,
        "Outputs": {
            "ServiceArn": {"Value": names.service_arn},
            "ObserverRoleArn": {"Value": names.observer_role_arn},
            "PodTaskRoleArn": {"Value": names.pod_task_role_arn},
            "StorageBucketName": {"Value": names.bucket_name},
        },
    }


def aws_erasure_receipt(
    *,
    account_id: str,
    region: str,
    names: AwsResourceNames,
    custody_mode: str,
    pod_receipt: dict[str, Any],
    pod_revoked: list[str],
    hussh_revoked: list[str],
    now: datetime | None = None,
) -> dict[str, Any]:
    """Build deterministic version-1 owner-access revocation receipt for an AWS pod."""
    today = (now or datetime.now(timezone.utc)).date()
    remaining = [
        names.service_arn,
        names.cluster_arn,
        names.pod_task_role_arn,
        names.observer_role_arn,
        names.signing_secret_arn,
        names.bucket_arn,
    ]
    receipt: dict[str, Any] = {
        "version": AWS_RECEIPT_VERSION,
        "accountId": account_id,
        "region": region,
        "stackName": names.stack_name,
        "agentErased": pod_receipt,
        "agentAccessRevoked": list(pod_revoked),
        "husshAccessRevoked": list(hussh_revoked),
        "remainingResources": remaining,
        "nextStep": (
            f"Delete CloudFormation stack {names.stack_name} (and S3 bucket {names.bucket_name} "
            f"if retained) in AWS account {account_id} ({region}) to remove remaining resources "
            "and stop charges. Hussh has revoked its own observer and removal IAM policies and "
            "can no longer read or modify anything in your account."
        ),
    }
    if custody_mode == CUSTODY_OWNER_KMS:
        remaining.append(names.kms_alias_arn)
        receipt["kmsKey"] = {
            "alias": names.kms_alias,
            "disabled": True,
            "scheduledForDeletion": False,
            "minPendingWindowDays": KMS_MIN_PENDING_WINDOW_DAYS,
            "earliestDeletionIfScheduledToday": (
                today + timedelta(days=KMS_MIN_PENDING_WINDOW_DAYS)
            ).isoformat(),
        }
    return receipt


def evaluate_aws_readiness(
    spec: PodSpec,
    *,
    image_digest: str = "",
    sts_probe: bool = False,
    sts_client: Any = None,
) -> dict[str, Any]:
    """Evaluate Floci-backed dev readiness for an owner AWS pod without claiming live admission."""
    from hushh_mcp.services.pod_s3_object_store import (  # noqa: PLC0415
        resolve_aws_boto3_client_kwargs,
    )
    from hushh_mcp.services.provider_capability_registry import (  # noqa: PLC0415
        PROVIDER_CAPABILITY_REGISTRY,
    )

    acct = str(spec.user_cloud_account_id or "").strip()
    region = str(spec.user_cloud_region or "").strip()
    role_arn = str(spec.user_cloud_role_arn or "").strip()
    digest = (image_digest or spec.expected_image_digest or "").strip()
    hub_caller = (os.getenv("HUSSH_CONSENT_PLANE_SA") or "").strip()

    coords_ok = owner_cloud_coordinates_complete(
        BACKEND_USER_AWS,
        {"account_id": acct, "region": region, "role_arn": role_arn},
    )
    account_valid = bool(_ACCOUNT_ID_RE.fullmatch(acct))
    role_matches_account = account_valid and role_arn.startswith(f"arn:aws:iam::{acct}:role/")
    digest_pinned = bool(_DIGEST_RE.fullmatch(digest)) and digest != _PLACEHOLDER_DIGEST
    custody = effective_custody_mode(spec)
    custody_valid = custody in {CUSTODY_OWNER_KMS, CUSTODY_ACE_ENVELOPE}
    hub_caller_present = bool(hub_caller)

    floci_endpoint = ""
    floci_gate_ok = False
    blockers: list[str] = []
    try:
        floci_endpoint = require_floci_only_aws_readiness_endpoint()
        floci_gate_ok = bool(floci_endpoint)
    except AwsFlociGateRefused as exc:
        blockers.append(str(exc))

    if not coords_ok:
        blockers.append("incomplete user_aws coordinates (account_id, region, role_arn)")
    if not role_matches_account:
        blockers.append("role_arn does not belong to the declared 12-digit AWS account_id")
    if not digest_pinned:
        blockers.append("container image digest must be pinned to a non-placeholder sha256")
    if not hub_caller_present:
        blockers.append("HUSSH_CONSENT_PLANE_SA is required for in-pod ingress lock")

    sts_reachable: bool | None = None
    if sts_probe:
        if not floci_gate_ok:
            sts_reachable = False
        else:
            try:
                client = sts_client
                if client is None:
                    import boto3  # type: ignore[import-not-found]  # noqa: PLC0415

                    client = boto3.client("sts", **resolve_aws_boto3_client_kwargs("sts"))
                kwargs: dict[str, Any] = {
                    "RoleArn": role_arn,
                    "RoleSessionName": "hussh-aws-readiness-probe",
                }
                if spec.expected_setup_nonce:
                    kwargs["ExternalId"] = spec.expected_setup_nonce
                assumed = client.assume_role(**kwargs)
                sts_reachable = bool((assumed.get("Credentials") or {}).get("SessionToken"))
            except Exception as exc:  # noqa: BLE001
                sts_reachable = False
                blockers.append(f"Floci STS AssumeRole probe failed: {exc}")

    aws_cap = PROVIDER_CAPABILITY_REGISTRY[BACKEND_USER_AWS]
    checks: dict[str, Any] = {
        "coordinates_complete": coords_ok,
        "role_matches_account": role_matches_account,
        "image_digest_pinned": digest_pinned,
        "custody_mode_supported": custody_valid,
        "hub_caller_configured": hub_caller_present,
        "floci_loopback_enforced": floci_gate_ok,
        "sts_assume_role_verified": sts_reachable,
    }
    ready = (
        coords_ok
        and role_matches_account
        and digest_pinned
        and custody_valid
        and hub_caller_present
        and floci_gate_ok
        and (sts_reachable is not False)
    )
    return {
        "target": BACKEND_USER_AWS,
        "readinessPlane": "floci_loopback_only",
        "flociEndpoint": floci_endpoint,
        "custodyMode": custody,
        "readyForFlociDevRehearsal": ready,
        "executionQualified": aws_cap.sandbox_capability.execution_qualified,
        "registrySqlAdmitted": aws_cap.registry_sql_admitted,
        "checks": checks,
        "blockers": blockers,
    }


__all__ = [
    "AWS_RECEIPT_VERSION",
    "BINDING_TAG",
    "INCARNATION_TAG",
    "KMS_MIN_PENDING_WINDOW_DAYS",
    "NONCE_TAG",
    "OBSERVER_POLICY_NAME",
    "POD_ENDPOINT_TAG",
    "POD_RUNTIME_POLICY_NAME",
    "REMOVAL_POLICY_NAME",
    "TENANCY_TAG",
    "AwsFlociGateRefused",
    "AwsPlanInputs",
    "AwsResourceNames",
    "aws_binding_is_valid",
    "aws_digest_matches",
    "aws_erasure_receipt",
    "aws_keyed_digest",
    "aws_owner_tags",
    "aws_pod_slug",
    "aws_resource_names",
    "aws_setup_binding",
    "evaluate_aws_readiness",
    "hussh_observer_policy_document",
    "hussh_removal_policy_document",
    "pod_runtime_policy_document",
    "render_cloudformation_template",
    "require_floci_only_aws_readiness_endpoint",
]
