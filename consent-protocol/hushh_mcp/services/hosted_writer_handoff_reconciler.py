# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Automated reconciler for interrupted hosted GCP writer-handoff states.

When an interrupted configuration/upgrade restart leaves a ``hussh_hosted`` GCP
pod's sealed commit log in ``pod_upgrade_idle`` (``handoff.phase == "idle"``,
``handoff.operationId == op_id``) with no active ``upgradeLease``, writes stall with
``PodLogFenced`` until either:
1. If the pod's running ``runtimeEpoch`` matches the fenced writer lease, the hub
   releases that same-epoch handoff via ``POST /api/one/pod/upgrade/release``; or
2. If the pod restarted into a newer ``runtimeEpoch`` (so same-epoch release is
   refused as stale incarnation), the hub stamps ``HUSSH_POD_WRITER_OPERATION`` on
   the Cloud Run service to the idle marker's ``operationId`` under
   ``HostedGcpAuthority`` and rotates a clean revision so the new writer claims
   succession legitimately.
"""

from __future__ import annotations

import asyncio
import copy
import os
from dataclasses import dataclass
from typing import Any

from hushh_mcp.services.gcp_run_client import GcpRunClient
from hushh_mcp.services.hosted_gcp_placement import retained_hosted_placement
from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffClient, service_incarnation


@dataclass(frozen=True)
class WriterHandoffReconcileResult:
    action: str
    operation_id: str
    incarnation: str
    runtime_epoch: str
    service: str


def reconcile_interrupted_hosted_writer_handoff(
    row: dict[str, Any],
    *,
    upgrade_status: dict[str, Any] | None = None,
    gcp_client: GcpRunClient | None = None,
    handoff_client: PodUpgradeHandoffClient | None = None,
    execute: bool = False,
) -> WriterHandoffReconcileResult:
    """Detect and repair an interrupted idle writer-handoff on a hosted GCP pod."""
    if str(os.getenv("HUSHH_DEPLOY_ENV") or "").strip().lower() != "dev":
        raise PermissionError("Writer-handoff reconciliation is fenced to dev")
    placement = retained_hosted_placement(row)
    if placement is None:
        raise ValueError("Row does not carry verified Hussh-Hosted GCP placement")
    metadata = row.get("backend_metadata") or {}
    if metadata.get("upgradeLease") is not None or "erasure" in metadata:
        raise RuntimeError(
            "Cannot reconcile writer handoff while an upgrade lease or erasure holds"
        )
    pod_url = str(metadata.get("url") or "").strip().rstrip("/")
    if not pod_url.startswith("https://"):
        raise ValueError("Hosted pod URL is unavailable for writer reconciliation")

    handoff = handoff_client or PodUpgradeHandoffClient(url=pod_url, hushh_id=placement.hushh_id)
    status = (
        upgrade_status
        if upgrade_status is not None
        else handoff._request("GET", "/api/one/pod/upgrade/status")
    )
    state = str(status.get("state") or "").strip()
    op_id = str(status.get("operationId") or "").strip()
    incarnation = str(status.get("incarnation") or "").strip()
    runtime_epoch = str(status.get("runtimeEpoch") or "").strip()

    if state == "accepting" and not op_id:
        return WriterHandoffReconcileResult(
            action="already_accepting",
            operation_id="",
            incarnation=incarnation,
            runtime_epoch=runtime_epoch,
            service=placement.service,
        )

    idle_receipt = status.get("idleReceipt") if isinstance(status.get("idleReceipt"), dict) else {}
    idle_op_id = str(idle_receipt.get("operationId") or op_id).strip()
    if state != "idle" or not idle_op_id:
        raise RuntimeError(f"Unsupported writer handoff state {state!r} for reconciliation")

    idle_epoch = str(idle_receipt.get("runtimeEpoch") or "").strip()
    same_epoch = bool(not idle_epoch or idle_epoch == runtime_epoch)

    if not execute:
        return WriterHandoffReconcileResult(
            action="plan_release_same_epoch" if same_epoch else "plan_stamp_writer_operation",
            operation_id=idle_op_id,
            incarnation=incarnation,
            runtime_epoch=runtime_epoch,
            service=placement.service,
        )

    if same_epoch:
        released = handoff.release(operation_id=idle_op_id, incarnation=incarnation)
        if isinstance(released, dict) and released.get("state") == "accepting":
            return WriterHandoffReconcileResult(
                action="released_same_epoch",
                operation_id=idle_op_id,
                incarnation=incarnation,
                runtime_epoch=runtime_epoch,
                service=placement.service,
            )

    # Cross-epoch recovery after an interrupted restart: stamp HUSSH_POD_WRITER_OPERATION
    # to the idle marker's operationId on the Cloud Run service and replace cleanly.
    client = gcp_client or GcpRunClient(project=placement.project, region=placement.region)
    current = client.get_service(placement.service)
    if current is None:
        raise RuntimeError(f"Hosted Cloud Run service {placement.service!r} not found")
    updated = copy.deepcopy(current)
    containers = (
        updated.setdefault("spec", {})
        .setdefault("template", {})
        .setdefault("spec", {})
        .setdefault("containers", [{}])
    )
    env_list = list(containers[0].get("env") or [])
    env_list = [
        e
        for e in env_list
        if e.get("name") not in {"HUSSH_POD_WRITER_PROTOCOL", "HUSSH_POD_WRITER_OPERATION"}
    ]
    env_list.extend(
        [
            {"name": "HUSSH_POD_WRITER_PROTOCOL", "value": "1"},
            {"name": "HUSSH_POD_WRITER_OPERATION", "value": idle_op_id},
        ]
    )
    containers[0]["env"] = env_list
    replaced = client.replace_service(
        placement.service,
        updated,
        revision_nonce=f"reconcile-{idle_op_id[:16]}",
        expected_uid=placement.service_uid,
    )
    new_incarnation = service_incarnation(replaced) or incarnation
    return WriterHandoffReconcileResult(
        action="stamped_writer_operation",
        operation_id=idle_op_id,
        incarnation=new_incarnation,
        runtime_epoch=runtime_epoch,
        service=placement.service,
    )


async def reconcile_interrupted_hosted_writer_handoff_async(
    row: dict[str, Any],
    *,
    upgrade_status: dict[str, Any] | None = None,
    gcp_client: GcpRunClient | None = None,
    handoff_client: PodUpgradeHandoffClient | None = None,
    execute: bool = False,
) -> WriterHandoffReconcileResult:
    return await asyncio.to_thread(
        reconcile_interrupted_hosted_writer_handoff,
        row,
        upgrade_status=upgrade_status,
        gcp_client=gcp_client,
        handoff_client=handoff_client,
        execute=execute,
    )


__all__ = [
    "WriterHandoffReconcileResult",
    "reconcile_interrupted_hosted_writer_handoff",
    "reconcile_interrupted_hosted_writer_handoff_async",
]
