# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Azure `Microsoft.App/jobs` (`2025-01-01`) ARM helpers for Option A CLI workers (#9511)."""

from __future__ import annotations

import re
import time
from typing import Any, Optional

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_container_app_renderer import refuse_metered_configuration

DEFAULT_WORKSPACE_JOB_NAME = "caj-hussh-one-ws"
_JOB_NAME_RE = re.compile(r"^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$")
_TERMINAL_AZURE_JOB_STATUSES = frozenset({"Succeeded", "Failed", "Canceled", "Stopped"})


def workspace_job_resource_id(
    subscription_id: str,
    resource_group: str,
    job_name: str = DEFAULT_WORKSPACE_JOB_NAME,
) -> str:
    clean_name = str(job_name or "").strip()
    if not _JOB_NAME_RE.fullmatch(clean_name):
        raise ValueError(f"invalid Azure Container Apps Job name {job_name!r}")
    sub = str(subscription_id or "").strip().strip("/")
    rg = str(resource_group or "").strip().strip("/")
    if not sub or not rg:
        raise ValueError("subscription_id and resource_group are required")
    return f"/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/jobs/{clean_name}"


def get_workspace_job(arm: ArmClient, job_path: str) -> Optional[dict[str, Any]]:
    found = arm.get_or_none(
        job_path,
        api_version=API_VERSIONS["container_apps"],
        op="get workspace job",
    )
    return dict(found) if isinstance(found, dict) else None


def upsert_workspace_job(
    arm: ArmClient,
    job_path: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    refuse_metered_configuration(body)
    settled = arm.put(
        job_path,
        api_version=API_VERSIONS["container_apps"],
        body=body,
        op="upsert workspace job",
    )
    return dict(settled)


def run_workspace_job_execution(
    arm: ArmClient,
    job_path: str,
    start_body: dict[str, Any],
    *,
    timeout_s: float = 300.0,
    poll_interval_s: float = 1.0,
) -> dict[str, Any]:
    refuse_metered_configuration(start_body)
    api_ver = API_VERSIONS["container_apps"]
    started: dict[str, Any] = dict(
        arm.post(
            f"{job_path}/start",
            api_version=api_ver,
            body=start_body,
            op="start workspace job execution",
        )
    )
    props = started.get("properties") if isinstance(started.get("properties"), dict) else started
    status = str((props or {}).get("status") or "")
    if status in _TERMINAL_AZURE_JOB_STATUSES:
        return started

    exec_name = str(started.get("name") or "").strip()
    if not exec_name and isinstance(started.get("id"), str) and "/executions/" in started["id"]:
        exec_name = started["id"].rsplit("/executions/", 1)[-1].strip("/")
    if not exec_name:
        return started

    deadline = time.monotonic() + max(1.0, float(timeout_s))
    current: dict[str, Any] = started
    while True:
        c_props = (
            current.get("properties") if isinstance(current.get("properties"), dict) else current
        )
        c_status = str((c_props or {}).get("status") or "")
        if c_status in _TERMINAL_AZURE_JOB_STATUSES:
            return current
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Azure Container Apps Job execution timed out")
        time.sleep(min(poll_interval_s, remaining))
        current = dict(
            arm.get(
                f"{job_path}/executions/{exec_name}",
                api_version=api_ver,
                op="poll workspace job execution",
            )
        )
