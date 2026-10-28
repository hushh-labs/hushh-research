"""Validate desired resources separately from Google-observed incarnation evidence."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from hushh_mcp.services.gcp_backend import _service_name
from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.private_gcp_deployment import FORBIDDEN_PRIVATE_ENV, HOSTING_ENV


def verify_private_observation(
    deployment: Any, service: dict[str, Any], *, require_uid: bool = True, frozen: bool = False
) -> None:
    deployment.validate(frozen=frozen)

    try:
        metadata = service["metadata"]
        container = service["spec"]["template"]["spec"]["containers"][0]
        runtime = service["spec"]["template"]["spec"]["serviceAccountName"]
        entries = container["env"]
        env = {entry["name"]: entry.get("value") for entry in entries}
        valid = (
            len(env) == len(entries)
            and metadata["name"] == _service_name(deployment.owner)
            and (
                metadata["namespace"] == deployment.project
                or (
                    deployment.project_number is not None
                    and metadata["namespace"] == deployment.project_number
                )
            )
            and metadata["labels"]["hussh-tenancy"] == deployment.tenancy
            and runtime == deployment.runtime_principal
            and container["image"] == deployment.image
            and (
                marker_matches(deployment, env.get(HOSTING_ENV), service, frozen=frozen)
                if deployment.hosting_mode == "hussh_hosted" or HOSTING_ENV in env
                else True
            )
            and (
                not require_uid
                or deployment.hosting_mode != "hussh_hosted"
                or (
                    env.get("HUSSH_POD_WRITER_PROTOCOL") == "1"
                    and isinstance(env.get("HUSSH_POD_WRITER_OPERATION"), str)
                    and 1 <= len(env["HUSSH_POD_WRITER_OPERATION"]) <= 256
                    and env["HUSSH_POD_WRITER_OPERATION"] != "unassigned"
                )
            )
            and env["HUSSH_ID"] == deployment.owner
            and env["HUSHH_DEPLOY_ENV"] == deployment.environment
            and env["GOOGLE_CLOUD_PROJECT"] == deployment.project
            and env["HUSSH_POD_KMS_KEY"] == deployment.kms_key
            and env["POD_STORAGE_GCS_BUCKET"] == deployment.bucket
            and env["HUSSH_POD_USER_ADC_ENABLED"]
            == ("true" if deployment.hosting_mode == "user_gcp" else "false")
            and not any(key in env for key in FORBIDDEN_PRIVATE_ENV)
            and "HUSSH_POD_MANAGED_MODEL_ENABLED" not in env
            and (
                not require_uid
                or deployment.service_uid is None
                or GcpRunClient.service_uid(service) == deployment.service_uid
            )
        )
    except (KeyError, TypeError, IndexError):
        valid = False
    if not valid:
        raise ValueError("Private pod deployed resources differ from admitted authority")


def marker_matches(
    deployment: Any, value: Any, service: dict[str, Any], *, frozen: bool = False
) -> bool:
    if value == deployment.encoded(frozen=frozen):
        return True
    from hushh_mcp.services.gcp_run_client import GcpRunClient

    # Google assigns UID after creation. The first immutable revision cannot
    # know it in advance; only its independently recorded incarnation may
    # accept that exact initial marker on subsequent readback.
    return bool(
        deployment.service_uid is not None
        and GcpRunClient.service_uid(service) == deployment.service_uid
        and value == replace(deployment, service_uid=None).encoded(frozen=frozen)
    )
