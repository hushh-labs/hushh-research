"""Capability admission and lost-response observation within the update owner."""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING, Any

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.pod_update_identity import approved_browser_plan

if TYPE_CHECKING:
    from hushh_mcp.services.pod_browser.capability_update import GcpBrowserCapabilityPlan
    from hushh_mcp.services.pod_files.azure_capability import AzureFilesCapabilityPlan
    from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan


async def admit_capabilities(
    registry: Any, row: dict, *, approval_matches: bool, recoverable_operation: bool
) -> tuple[FilesCapabilityPlan | AzureFilesCapabilityPlan | None, GcpBrowserCapabilityPlan | None]:
    from hushh_mcp.services.personal_agent_provisioning_service import (
        PersonalAgentUpgradeNotApprovedError,
        PersonalAgentUpgradeUnsupportedError,
    )

    metadata = row.get("backend_metadata") or {}
    approval_metadata, held = metadata.get("upgradeApproval"), metadata.get("upgradeLease")
    from hushh_mcp.services.pod_update_identity import approved_files_plan

    files_capability = (
        approved_files_plan(approval_metadata) if isinstance(approval_metadata, dict) else None
    )
    if files_capability is not None and not (
        approval_matches or (held is not None and recoverable_operation)
    ):
        raise PersonalAgentUpgradeNotApprovedError(
            "Files activation requires its exact owner approval"
        )
    if files_capability is not None and held is None:
        from hushh_mcp.services.pod_files.capability_contract import admission_ready

        if not await admission_ready(registry, files_capability):
            raise PersonalAgentUpgradeUnsupportedError("Files upgrade recovery schema is not ready")
    browser_capability = (
        approved_browser_plan(approval_metadata) if isinstance(approval_metadata, dict) else None
    )
    if browser_capability is not None:
        from hushh_mcp.services.pod_browser.update_offer import require_browser_schema

        await require_browser_schema(registry)
    return files_capability, browser_capability


async def recover_capability_ack(
    registry: Any, *, row: dict, spec: PodSpec, backend: Any, lease: Any
) -> tuple[dict, dict, dict | None]:
    """Discover one saved replacement and retain its lease; never dispatch a PUT."""
    metadata = dict(row.get("backend_metadata") or {})
    receipt = metadata.get("upgradeAcknowledgement")
    if (
        (spec.files_upgrade_plan or spec.browser_upgrade_plan)
        and isinstance(lease, str)
        and lease
        and (
            not isinstance(receipt, dict)
            or receipt.get("attemptId") != hashlib.sha256(lease.encode()).hexdigest()
        )
    ):
        if spec.browser_upgrade_plan:
            from hushh_mcp.services.pod_browser import update_recovery as browser_recovery

            discover = browser_recovery.discover_replacement
        else:
            from hushh_mcp.services.pod_files import update_recovery as files_recovery

            discover = files_recovery.discover_replacement

        receipt = await discover(row=row, spec=spec, backend=backend, lease=lease)
        if receipt is not None:
            updated = {**metadata, "upgradeAcknowledgement": receipt}
            published = await registry.record_image_upgrade(
                user_id=row["user_id"],
                observed=row,
                expected_lease=lease,
                previous_metadata=metadata,
                backend_metadata=updated,
                retain_lease=True,
            )
            if published is not True:
                raise RuntimeError("Capability replacement recovery lost authority")
            metadata = updated
            row = {**row, "backend_metadata": updated}
    return row, metadata, receipt


def retained_update_observation(row: dict) -> bool:
    from hushh_mcp.services.personal_agent_provisioning_service import (
        upgrade_operation_is_recoverable,
    )

    metadata = row.get("backend_metadata") or {}
    return (
        isinstance(metadata.get("upgradeAcknowledgement"), dict)
        or isinstance(metadata.get("filesUpgradeCheckpoint"), dict)
        or (
            (metadata.get("upgradeApproval") or {}).get("version") == 2
            and upgrade_operation_is_recoverable(row)
        )
    )
