# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Owner-account AWS ECS Fargate sovereign compute adapter (`user_aws`).

Authority matrix (aligned with ``user_azure_backend.py``):
- Setup happens once inside the owner's AWS account via CloudFormation
  (``aws_setup_plan.render_cloudformation_template``). Hussh holds zero standing
  resource-creation or resource-deletion authority.
- ``provision`` (when ``live=True``) ATTACHES via federated STS ``AssumeRole``, reads
  the ECS Fargate service + task definition, verifies cryptographic owner-binding tags
  and approved container image digest, and returns a verified ``BackendHandle``.
- ``get`` distinguishes healthy/deploying ECS services from confirmed absence
  (``MISSING`` / ``INACTIVE`` -> ``status="gone"``), NEVER treating ``AccessDenied``
  as ``gone``.
- ``restart`` (``RestartableBackend``) re-verifies the owner-binding fence and triggers
  in-place ``ecs.update_service(..., forceNewDeployment=True)``.
- ``deprovision`` refuses delete authority; ``erase_owner_access`` +
  ``resume_owner_access_revocation`` (``OwnerAccessErasableBackend``) checkpoint pod
  crypto-erasure first, scale ECS to zero, disable the owner KMS key (without
  scheduling deletion), delete the pod's inline IAM policy, and delete Hussh's own
  observer + removal IAM policies LAST.
- While ``PROVIDER_CAPABILITY_REGISTRY["user_aws"].sandbox_capability.execution_qualified``
  is ``False``, all live control-plane calls are strictly fenced to loopback Floci
  (``FLOCI_ENDPOINT_URL``) in ``dev``/``test`` (zero outbound ``*.amazonaws.com`` traffic).
"""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from hushh_mcp.services.aws_setup_plan import (
    INCARNATION_TAG,
    NONCE_TAG,
    OBSERVER_POLICY_NAME,
    POD_ENDPOINT_TAG,
    POD_RUNTIME_POLICY_NAME,
    REMOVAL_POLICY_NAME,
    AwsResourceNames,
    aws_binding_is_valid,
    aws_erasure_receipt,
    aws_pod_slug,
    aws_resource_names,
    require_floci_only_aws_readiness_endpoint,
)
from hushh_mcp.services.byoc_key_custody import (
    WRAPPED_KEY_OBJECT_ENV,
    WRAPPED_LOG_KEY_OBJECT,
)
from hushh_mcp.services.compute_backend import (
    BACKEND_USER_AWS,
    CUSTODY_ACE_ENVELOPE,
    CUSTODY_OWNER_KMS,
    POD_CPU_MILLIS,
    POD_MEMORY,
    POD_REQUEST_CONCURRENCY,
    RESOURCE_TIER_ECONOMY,
    BackendHandle,
    BackendStatus,
    PodSpec,
    effective_custody_mode,
)
from hushh_mcp.services.pod_common_env import merge_pod_env, shared_non_gcp_pod_env
from hushh_mcp.services.pod_s3_object_store import resolve_aws_boto3_client_kwargs

_ACCOUNT_ID_RE = re.compile(r"^[0-9]{12}$")
_NONCE_RE = re.compile(r"^[0-9a-f]{16}$")
_DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}$")
_PLACEHOLDER_DIGEST = "sha256:" + "0" * 64


class AwsAgentUnreadable(RuntimeError):
    """Federated AWS read was refused or failed; never treated as confirmed absence."""


class AwsDeleteAuthorityRefused(PermissionError):
    """Hussh holds no delete authority in an owner AWS account."""


class AwsErasureRefused(RuntimeError):
    """Owner-access erasure precondition or checkpoint check failed."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class AwsServiceObservation:
    present: bool
    absence_confirmed: bool
    ready: bool
    service_arn: str = ""
    service_name: str = ""
    task_definition_arn: str = ""
    image: str = ""
    task_role_arn: str = ""
    desired_count: int = 0
    running_count: int = 0
    max_percent: int = 100
    tags: dict[str, str] | None = None
    observer_policies: tuple[str, ...] = ()
    gone_reason: str = ""


def _memory_mib(memory: str) -> str:
    text = memory.strip()
    if text.endswith("Gi"):
        return str(int(text[:-2]) * 1024)
    if text.endswith("Mi"):
        return str(int(text[:-2]))
    return "2048"


def _aws_error_code(exc: BaseException) -> tuple[str, int]:
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return "", 0
    err = response.get("Error") or {}
    meta = response.get("ResponseMetadata") or {}
    return str(err.get("Code") or ""), int(meta.get("HTTPStatusCode") or 0)


def _is_access_denied(exc: BaseException) -> bool:
    code, status = _aws_error_code(exc)
    return status in {401, 403} or code in {
        "AccessDenied",
        "AccessDeniedException",
        "UnauthorizedOperation",
        "InvalidClientTokenId",
    }


def _extract_digest(image: str) -> str:
    if "@" not in image:
        return ""
    candidate = image.rsplit("@", 1)[1].strip()
    return candidate if _DIGEST_RE.fullmatch(candidate) else ""


def _checkpoint_matches_spec(spec: PodSpec, agent_erased: Any, resume: Any) -> bool:
    nonce = resume.get("setupNonce") if isinstance(resume, dict) else None
    return (
        isinstance(resume, dict)
        and set(resume) == {"setupNonce"}
        and isinstance(nonce, str)
        and _NONCE_RE.fullmatch(nonce) is not None
        and isinstance(agent_erased, dict)
        and agent_erased.get("erased") is True
        and agent_erased.get("hushhId") == spec.hushh_id
        and bool(spec.expected_service_uid)
        and agent_erased.get("serviceUid") == spec.expected_service_uid
    )


class UserAwsBackend:
    """Per-owner AWS ECS Fargate adapter (`ComputeBackend` + sovereign BYOC protocols)."""

    backend_id = BACKEND_USER_AWS

    def __init__(
        self,
        *,
        account_id: str,
        region: str,
        role_arn: str,
        image_digest: str = "",
        live: bool = False,
        sts_client: Any = None,
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
        self._sts_client = sts_client

    @property
    def live(self) -> bool:
        return self._live

    def resource_names(self, hushh_id: str) -> AwsResourceNames:
        return aws_resource_names(
            hushh_id=hushh_id,
            account_id=self._account_id,
            region=self._region,
            observer_role_arn_override=self._role_arn,
        )

    def _assume_role_clients(
        self,
        *,
        external_id: str = "",
        services: tuple[str, ...] = ("ecs", "iam", "kms"),
    ) -> dict[str, Any]:
        require_floci_only_aws_readiness_endpoint()
        import boto3  # type: ignore[import-not-found]  # noqa: PLC0415

        sts = self._sts_client
        if sts is None:
            sts_kwargs = resolve_aws_boto3_client_kwargs("sts")
            sts_kwargs.setdefault("region_name", self._region)
            sts = boto3.client("sts", **sts_kwargs)

        assume_kwargs: dict[str, Any] = {
            "RoleArn": self._role_arn,
            "RoleSessionName": "hussh-observer-session",
        }
        if external_id:
            assume_kwargs["ExternalId"] = external_id
        try:
            assumed = sts.assume_role(**assume_kwargs)
        except Exception as exc:  # noqa: BLE001
            if _is_access_denied(exc):
                raise AwsAgentUnreadable(
                    "AWS STS refused federated observer role assumption"
                ) from None
            raise AwsAgentUnreadable("AWS STS AssumeRole call failed") from None

        creds = assumed.get("Credentials") or {}
        out: dict[str, Any] = {}
        for svc in services:
            svc_kwargs = resolve_aws_boto3_client_kwargs(svc)
            svc_kwargs["region_name"] = self._region
            svc_kwargs["aws_access_key_id"] = creds["AccessKeyId"]
            svc_kwargs["aws_secret_access_key"] = creds["SecretAccessKey"]
            svc_kwargs["aws_session_token"] = creds["SessionToken"]
            out[svc] = boto3.client(svc, **svc_kwargs)
        return out

    def observe_service_sync(
        self,
        *,
        cluster_name: str,
        service_name: str,
        observer_role_name: str = "",
        external_id: str = "",
        inspect_task_and_policies: bool = True,
    ) -> AwsServiceObservation:
        clients = self._assume_role_clients(
            external_id=external_id,
            services=("ecs", "iam") if inspect_task_and_policies else ("ecs",),
        )
        ecs = clients["ecs"]
        try:
            described = ecs.describe_services(
                cluster=cluster_name,
                services=[service_name],
                include=["TAGS"],
            )
        except Exception as exc:  # noqa: BLE001
            code, _ = _aws_error_code(exc)
            if code in {"ClusterNotFoundException", "ServiceNotFoundException"}:
                return AwsServiceObservation(
                    present=False,
                    absence_confirmed=True,
                    ready=False,
                    gone_reason=code,
                )
            if _is_access_denied(exc):
                raise AwsAgentUnreadable(
                    "AWS ECS refused DescribeServices for observer role"
                ) from None
            raise AwsAgentUnreadable("AWS ECS DescribeServices failed") from None

        services_list = described.get("services") or []
        failures = described.get("failures") or []
        if not services_list:
            missing = any(str(f.get("reason") or "") == "MISSING" for f in failures)
            return AwsServiceObservation(
                present=False,
                absence_confirmed=missing or not failures,
                ready=False,
                gone_reason="service_missing",
            )

        svc = services_list[0]
        svc_status = str(svc.get("status") or "").upper()
        if svc_status == "INACTIVE":
            return AwsServiceObservation(
                present=False,
                absence_confirmed=True,
                ready=False,
                gone_reason="service_inactive",
            )

        raw_tags = svc.get("tags") or []
        tag_map = {
            str(entry.get("key") or entry.get("Key") or ""): str(
                entry.get("value") if "value" in entry else (entry.get("Value") or "")
            )
            for entry in raw_tags
            if isinstance(entry, dict)
        }
        desired = int(svc.get("desiredCount") or 0)
        running = int(svc.get("runningCount") or 0)
        deploy_cfg = svc.get("deploymentConfiguration") or {}
        max_pct = int(deploy_cfg.get("maximumPercent") or 100)
        task_def_arn = str(svc.get("taskDefinition") or "")
        ready = svc_status == "ACTIVE" and (running >= 1 or desired == 0)

        image = ""
        task_role_arn = ""
        observer_policies: tuple[str, ...] = ()
        if inspect_task_and_policies and task_def_arn:
            try:
                td_resp = ecs.describe_task_definition(taskDefinition=task_def_arn)
                td = td_resp.get("taskDefinition") or {}
                task_role_arn = str(td.get("taskRoleArn") or "")
                containers = td.get("containerDefinitions") or []
                if containers:
                    image = str(containers[0].get("image") or "")
            except Exception as exc:  # noqa: BLE001
                if _is_access_denied(exc):
                    raise AwsAgentUnreadable(
                        "AWS ECS refused DescribeTaskDefinition for observer role"
                    ) from None
                raise AwsAgentUnreadable("AWS ECS DescribeTaskDefinition failed") from None

            if observer_role_name and "iam" in clients:
                try:
                    pol_resp = clients["iam"].list_role_policies(RoleName=observer_role_name)
                    observer_policies = tuple(pol_resp.get("PolicyNames") or ())
                except Exception as exc:  # noqa: BLE001
                    if _is_access_denied(exc):
                        raise AwsAgentUnreadable(
                            "AWS IAM refused ListRolePolicies for observer role"
                        ) from None
                    raise AwsAgentUnreadable("AWS IAM ListRolePolicies failed") from None

        return AwsServiceObservation(
            present=True,
            absence_confirmed=False,
            ready=ready,
            service_arn=str(svc.get("serviceArn") or ""),
            service_name=str(svc.get("serviceName") or service_name),
            task_definition_arn=task_def_arn,
            image=image,
            task_role_arn=task_role_arn,
            desired_count=desired,
            running_count=running,
            max_percent=max_pct,
            tags=tag_map,
            observer_policies=observer_policies,
        )

    def _verified_live_handle(
        self,
        spec: PodSpec,
        observation: AwsServiceObservation,
        names: AwsResourceNames,
    ) -> BackendHandle:
        from hushh_mcp.services.gcp_backend import A2A_ADDRESS_BASE  # noqa: PLC0415

        if not observation.present:
            raise RuntimeError("owner AWS ECS service is not present in the target account")
        tags = observation.tags or {}
        if not aws_binding_is_valid(
            tags,
            hushh_id=spec.hushh_id,
            account_id=self._account_id,
            region=self._region,
        ):
            raise RuntimeError(
                "the ECS service in this AWS account does not carry a valid Hussh owner binding"
            )
        incarnation = str(tags.get(INCARNATION_TAG) or "").strip()
        if not incarnation:
            raise RuntimeError("owner AWS ECS service is missing hussh-incarnation tag")
        if spec.expected_service_uid and incarnation != spec.expected_service_uid:
            raise RuntimeError("owner AWS ECS service incarnation differs from recorded pod")
        nonce = str(tags.get(NONCE_TAG) or "").strip()
        if spec.expected_setup_nonce and nonce != spec.expected_setup_nonce:
            raise RuntimeError("owner AWS ECS service setup nonce differs from recorded pod")

        digest = _extract_digest(observation.image)
        if not digest or digest == _PLACEHOLDER_DIGEST:
            raise RuntimeError("owner AWS ECS task image must be pinned by sha256 digest")
        expected_digest = (spec.expected_image_digest or "").strip()
        if not expected_digest and self._image_digest != _PLACEHOLDER_DIGEST:
            expected_digest = self._image_digest
        if expected_digest:
            normalized_expected = (
                _extract_digest(expected_digest) if "@" in expected_digest else expected_digest
            )
            if digest != normalized_expected:
                raise RuntimeError("owner AWS ECS task image digest is not approved for this pod")

        if observation.desired_count > 1 or observation.max_percent > 100:
            raise RuntimeError("owner AWS ECS service violates single-writer Fargate invariant")
        if not observation.task_role_arn.startswith(f"arn:aws:iam::{self._account_id}:role/"):
            raise RuntimeError("owner AWS ECS task definition lacks an account-local taskRoleArn")
        if spec.expected_runtime_principal and (
            observation.task_role_arn != spec.expected_runtime_principal
        ):
            raise RuntimeError("owner AWS ECS taskRoleArn differs from recorded runtime principal")
        required_policies = {OBSERVER_POLICY_NAME, REMOVAL_POLICY_NAME}
        if observation.observer_policies and not required_policies.issubset(
            set(observation.observer_policies)
        ):
            raise RuntimeError(
                "federated AWS observer role is missing required observer/removal inline policies"
            )

        pod_url = str(tags.get(POD_ENDPOINT_TAG) or "").strip().rstrip("/")
        if not pod_url:
            slug = aws_pod_slug(spec.hushh_id)
            pod_url = f"https://hussh-one-{slug}.{self._region}.aws.internal"
        revision = (
            observation.task_definition_arn.rsplit("/", 1)[-1]
            if observation.task_definition_arn
            else names.task_family
        )
        service_arn = observation.service_arn or names.service_arn
        return BackendHandle(
            external_agent_id=service_arn,
            a2a_route=f"{A2A_ADDRESS_BASE}/{spec.hushh_id}",
            status="live" if observation.ready else "deploying",
            backend=BACKEND_USER_AWS,
            backend_metadata={
                "tenancy": "user-owned",
                "accountId": self._account_id,
                "region": self._region,
                "roleArn": self._role_arn,
                "computeProfile": "aws_fargate",
                "custodyMode": effective_custody_mode(spec),
                "service": observation.service_name or names.service_name,
                "serviceArn": service_arn,
                "serviceUid": incarnation,
                "revision": revision,
                "url": pod_url,
                "ingress": "internal",
                "image": observation.image,
                "image_digest": digest,
                "runtime_principal_id": observation.task_role_arn,
                "setupNonce": nonce,
                "keyless": True,
                "credential": "federated STS observer: read, restart, and access revocation only",
                "livenessMode": RESOURCE_TIER_ECONOMY,
            },
        )

    async def provision(self, spec: PodSpec) -> BackendHandle:
        if not self._live:
            from hushh_mcp.services.gcp_backend import A2A_ADDRESS_BASE  # noqa: PLC0415

            rendered = self.render_deploy_config(spec)
            family = rendered["taskDefinition"]["family"]
            return BackendHandle(
                external_agent_id=(
                    f"arn:aws:ecs:{self._region}:{self._account_id}:service/hussh-one/{family}"
                ),
                a2a_route=f"{A2A_ADDRESS_BASE}/{spec.hushh_id}",
                status="planned",
                backend=BACKEND_USER_AWS,
                backend_metadata={
                    "tenancy": "user-owned",
                    "accountId": self._account_id,
                    "region": self._region,
                    "roleArn": self._role_arn,
                    "computeProfile": "aws_fargate",
                    "custodyMode": effective_custody_mode(spec),
                },
            )

        names = self.resource_names(spec.hushh_id)
        observation = await asyncio.to_thread(
            self.observe_service_sync,
            cluster_name=names.cluster_name,
            service_name=names.service_name,
            observer_role_name=names.observer_role_name,
            external_id=spec.expected_setup_nonce or "",
            inspect_task_and_policies=True,
        )
        return self._verified_live_handle(spec, observation, names)

    async def deprovision(self, external_agent_id: str) -> None:
        if self._live:
            raise AwsDeleteAuthorityRefused(
                "Hussh holds no delete authority in your AWS account; erasure revokes "
                "access and returns a CloudFormation deletion receipt"
            )
        return None

    async def get(self, external_agent_id: str) -> BackendStatus:
        if not self._live:
            return BackendStatus(
                external_agent_id=(external_agent_id or None),
                status="planned",
                healthy=False,
            )
        prefix = f"arn:aws:ecs:{self._region}:{self._account_id}:service/"
        if not external_agent_id or not external_agent_id.startswith(prefix):
            raise ValueError("external_agent_id does not belong to the recorded AWS account/region")
        suffix = external_agent_id[len(prefix) :]
        parts = [p for p in suffix.split("/") if p]
        if len(parts) != 2:
            raise ValueError("external_agent_id must have cluster/service ECS ARN form")
        cluster_name, service_name = parts[0], parts[1]
        observation = await asyncio.to_thread(
            self.observe_service_sync,
            cluster_name=cluster_name,
            service_name=service_name,
            inspect_task_and_policies=False,
        )
        if not observation.present:
            if not observation.absence_confirmed:
                raise AwsAgentUnreadable("AWS ECS service absence could not be confirmed")
            return BackendStatus(
                external_agent_id=external_agent_id,
                status="gone",
                healthy=False,
            )
        return BackendStatus(
            external_agent_id=observation.service_arn or external_agent_id,
            status="live" if observation.ready else "deploying",
            healthy=observation.ready,
        )

    async def restart(self, spec: PodSpec) -> dict[str, Any]:
        """Heal in place using ECS ``forceNewDeployment`` after owner-binding verification."""
        names = self.resource_names(spec.hushh_id)

        def _restart_sync() -> dict[str, Any]:
            obs = self.observe_service_sync(
                cluster_name=names.cluster_name,
                service_name=names.service_name,
                observer_role_name=names.observer_role_name,
                external_id=spec.expected_setup_nonce or "",
                inspect_task_and_policies=True,
            )
            handle = self._verified_live_handle(spec, obs, names)
            clients = self._assume_role_clients(
                external_id=str((handle.backend_metadata or {}).get("setupNonce") or ""),
                services=("ecs",),
            )
            resp = clients["ecs"].update_service(
                cluster=names.cluster_name,
                service=names.service_name,
                forceNewDeployment=True,
            )
            svc = resp.get("service") or {}
            td_arn = str(svc.get("taskDefinition") or obs.task_definition_arn)
            revision = td_arn.rsplit("/", 1)[-1] if td_arn else names.task_family
            return {
                "service": str(svc.get("serviceArn") or handle.external_agent_id),
                "revision": revision,
                "restarted": True,
            }

        return await asyncio.to_thread(_restart_sync)

    async def observe_erasure_target(self, spec: PodSpec) -> dict[str, str]:
        """Return verified serving incarnation metadata required by the erasure fence."""
        names = self.resource_names(spec.hushh_id)
        obs = await asyncio.to_thread(
            self.observe_service_sync,
            cluster_name=names.cluster_name,
            service_name=names.service_name,
            observer_role_name=names.observer_role_name,
            external_id=spec.expected_setup_nonce or "",
            inspect_task_and_policies=True,
        )
        handle = self._verified_live_handle(spec, obs, names)
        metadata = handle.backend_metadata or {}
        uid = str(metadata.get("serviceUid") or "")
        if spec.expected_service_uid and uid != spec.expected_service_uid:
            raise RuntimeError("owner AWS ECS service incarnation differs from erasure target")
        return {
            "service": str(metadata["service"]),
            "serviceUid": uid,
            "revision": str(metadata["revision"]),
            "podUrl": str(metadata["url"]).rstrip("/"),
        }

    def _revoke_access_sync(
        self,
        spec: PodSpec,
        *,
        nonce: str,
        pod_receipt: dict[str, Any],
    ) -> dict[str, Any]:
        names = self.resource_names(spec.hushh_id)
        custody = (
            spec.custody_mode.strip()
            if spec.custody_mode is not None and spec.custody_mode.strip()
            else effective_custody_mode(
                PodSpec(
                    hushh_id=spec.hushh_id,
                    phone_e164_hash=spec.phone_e164_hash,
                    pod_pubkey=spec.pod_pubkey,
                    deployment_target=BACKEND_USER_AWS,
                )
            )
        )
        services = ("ecs", "iam", "kms") if custody == CUSTODY_OWNER_KMS else ("ecs", "iam")
        clients = self._assume_role_clients(external_id=nonce, services=services)

        pod_revoked: list[str] = []
        hussh_revoked: list[str] = []

        # 1. Scale ECS service to desiredCount=0 (idempotent if already 0 or inactive).
        try:
            clients["ecs"].update_service(
                cluster=names.cluster_name,
                service=names.service_name,
                desiredCount=0,
            )
            pod_revoked.append(f"{names.service_arn}#desiredCount=0")
        except Exception as exc:  # noqa: BLE001
            code, _ = _aws_error_code(exc)
            if code in {"ServiceNotFoundException", "ServiceNotActiveException"}:
                pod_revoked.append(f"{names.service_arn}#desiredCount=0")
            elif _is_access_denied(exc):
                raise AwsErasureRefused(
                    "AWS ECS refused scaling pod service to zero during access revocation",
                    code="ECS_SCALE_ZERO_REFUSED",
                ) from None
            else:
                raise

        # 2. Disable owner KMS key without scheduling deletion (idempotent if already disabled).
        if custody == CUSTODY_OWNER_KMS:
            kms = clients["kms"]
            try:
                described = kms.describe_key(KeyId=names.kms_alias)
                key_id = str((described.get("KeyMetadata") or {}).get("KeyId") or names.kms_alias)
                kms.disable_key(KeyId=key_id)
            except Exception as exc:  # noqa: BLE001
                code, _ = _aws_error_code(exc)
                if code not in {"NotFoundException", "KMSInvalidStateException"}:
                    if _is_access_denied(exc):
                        raise AwsErasureRefused(
                            "AWS KMS refused disabling owner custody key",
                            code="KMS_DISABLE_REFUSED",
                        ) from None
                    raise
            pod_revoked.append(f"{names.kms_alias_arn}#disabled")

        # 3. Delete pod runtime inline IAM policy (idempotent on NoSuchEntity).
        iam = clients["iam"]
        try:
            iam.delete_role_policy(
                RoleName=names.pod_task_role_name,
                PolicyName=POD_RUNTIME_POLICY_NAME,
            )
        except Exception as exc:  # noqa: BLE001
            code, status = _aws_error_code(exc)
            if status != 404 and code != "NoSuchEntity":
                if _is_access_denied(exc):
                    raise AwsErasureRefused(
                        "AWS IAM refused deleting pod runtime inline policy",
                        code="POD_POLICY_REVOKE_REFUSED",
                    ) from None
                raise
        pod_revoked.append(f"{names.pod_task_role_arn}/policy/{POD_RUNTIME_POLICY_NAME}")

        # 4. Revoke Hussh's own inline policies LAST: observer first, removal grant very last.
        for policy_name in (OBSERVER_POLICY_NAME, REMOVAL_POLICY_NAME):
            try:
                iam.delete_role_policy(
                    RoleName=names.observer_role_name,
                    PolicyName=policy_name,
                )
            except Exception as exc:  # noqa: BLE001
                code, status = _aws_error_code(exc)
                if status != 404 and code != "NoSuchEntity":
                    if _is_access_denied(exc):
                        raise AwsErasureRefused(
                            f"AWS IAM refused deleting Hussh {policy_name} inline policy",
                            code="HUSSH_POLICY_REVOKE_REFUSED",
                        ) from None
                    raise
            hussh_revoked.append(f"{names.observer_role_arn}/policy/{policy_name}")

        return aws_erasure_receipt(
            account_id=self._account_id,
            region=self._region,
            names=names,
            custody_mode=custody,
            pod_receipt=pod_receipt,
            pod_revoked=pod_revoked,
            hussh_revoked=hussh_revoked,
        )

    async def _erase_with_fence(
        self,
        spec: PodSpec,
        *,
        crypto_erase: Callable[[dict[str, str]], Awaitable[dict]],
        checkpoint_only: bool = False,
    ) -> dict[str, Any]:
        names = self.resource_names(spec.hushh_id)
        obs = await asyncio.to_thread(
            self.observe_service_sync,
            cluster_name=names.cluster_name,
            service_name=names.service_name,
            observer_role_name=names.observer_role_name,
            external_id=spec.expected_setup_nonce or "",
            inspect_task_and_policies=True,
        )
        handle = self._verified_live_handle(spec, obs, names)
        metadata = handle.backend_metadata or {}
        nonce = str(metadata.get("setupNonce") or "")
        pod_receipt = await crypto_erase({"setupNonce": nonce})
        if not isinstance(pod_receipt, dict) or pod_receipt.get("erased") is not True:
            raise AwsErasureRefused(
                "the AWS pod did not confirm its crypto-erase; nothing was revoked",
                code="AGENT_ERASE_UNCONFIRMED",
            )
        if checkpoint_only:
            return pod_receipt
        return await asyncio.to_thread(
            self._revoke_access_sync,
            spec,
            nonce=nonce,
            pod_receipt=pod_receipt,
        )

    async def erase_owner_access(
        self,
        spec: PodSpec,
        *,
        crypto_erase: Callable[[dict[str, str]], Awaitable[dict]],
    ) -> dict[str, Any]:
        return await self._erase_with_fence(spec, crypto_erase=crypto_erase, checkpoint_only=False)

    async def checkpoint_owner_access(
        self,
        spec: PodSpec,
        *,
        crypto_erase: Callable[[dict[str, str]], Awaitable[dict]],
    ) -> None:
        await self._erase_with_fence(spec, crypto_erase=crypto_erase, checkpoint_only=True)

    async def resume_owner_access_revocation(
        self,
        spec: PodSpec,
        *,
        agent_erased: dict[str, Any],
        resume: dict[str, str],
    ) -> dict[str, Any]:
        """Finish a cut-short revocation from the hub's checkpoint without reading the pod."""
        if not _checkpoint_matches_spec(spec, agent_erased, resume):
            raise AwsErasureRefused(
                "the retained AWS erasure checkpoint does not name this pod; nothing was revoked",
                code="CHECKPOINT_MISMATCH",
            )
        return await asyncio.to_thread(
            self._revoke_access_sync,
            spec,
            nonce=resume["setupNonce"],
            pod_receipt=agent_erased,
        )

    async def health(self) -> bool:
        return True

    def render_deploy_config(self, spec: PodSpec) -> dict[str, Any]:
        hub_caller = (os.getenv("HUSSH_CONSENT_PLANE_SA") or "").strip()
        if not hub_caller:
            raise ValueError("the in-pod wall needs HUSSH_CONSENT_PLANE_SA; refusing a public pod")
        slug = aws_pod_slug(spec.hushh_id)
        family = f"hussh-one-{slug}"
        bucket = f"hussh-one-{self._account_id}-{slug}"
        kms_arn = f"arn:aws:kms:{self._region}:{self._account_id}:key/alias/{family}-custody"
        signing_secret_arn = (
            f"arn:aws:secretsmanager:{self._region}:{self._account_id}:secret:"
            f"{family}/app-signing-key"
        )
        custody = (
            spec.custody_mode.strip()
            if spec.custody_mode is not None and spec.custody_mode.strip()
            else effective_custody_mode(
                PodSpec(
                    hushh_id=spec.hushh_id,
                    phone_e164_hash=spec.phone_e164_hash,
                    pod_pubkey=spec.pod_pubkey,
                    deployment_target=BACKEND_USER_AWS,
                )
            )
        )
        custody_env: list[dict[str, str]]
        if custody == CUSTODY_ACE_ENVELOPE:
            custody_env = [{"name": "HUSSH_POD_CUSTODY_MODE", "value": CUSTODY_ACE_ENVELOPE}]
        else:
            custody_env = [
                {"name": "HUSSH_POD_CUSTODY_MODE", "value": custody},
                {"name": "HUSSH_POD_AWS_KMS_KEY_ARN", "value": kms_arn},
                {"name": WRAPPED_KEY_OBJECT_ENV, "value": WRAPPED_LOG_KEY_OBJECT},
            ]

        revision_id = (
            spec.expected_service_uid.strip()
            if spec.expected_service_uid and spec.expected_service_uid.strip()
            else f"{family}--{self._image_digest[-12:]}"
        )
        aws_overrides: list[dict[str, str]] = [
            {"name": "POD_STORAGE_BACKEND", "value": "commit_log"},
            {"name": "POD_STORAGE_S3_URI", "value": f"s3://{bucket}/pod"},
            *custody_env,
            {"name": "POD_DURABLE_IDENTITY_ENABLED", "value": "true"},
            {"name": "POD_AGENT_MEMORY_ENABLED", "value": "true"},
            {"name": "GOOGLE_GENAI_USE_VERTEXAI", "value": "false"},
            {"name": "HUSSH_POD_HUB_CALLER_EMAILS", "value": hub_caller},
            {"name": "HUSSH_AWS_SERVICE_NAME", "value": family},
            {"name": "HUSSH_AWS_TASK_REVISION", "value": revision_id},
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


__all__ = [
    "AwsAgentUnreadable",
    "AwsDeleteAuthorityRefused",
    "AwsErasureRefused",
    "AwsServiceObservation",
    "UserAwsBackend",
]
