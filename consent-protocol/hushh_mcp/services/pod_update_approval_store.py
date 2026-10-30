"""One durable owner approval; storage stays in the existing registry ledger."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

APPROVAL_SQL = """
            UPDATE personal_agent_registry
            SET backend_metadata = CASE
                -- A retry with the same idempotency key returns the first durable
                -- operation. Do not replace its operation id with a newly generated
                -- one after a lost acknowledgement.
                WHEN backend_metadata->'upgradeApproval'->>'releaseId' = :release_id
                 AND backend_metadata->'upgradeApproval'->>'idempotencyKey' = :idempotency_key
                 AND backend_metadata->'upgradeApproval'->>'targetImage' = :target_image
                THEN coalesce(backend_metadata, '{}'::jsonb)
                ELSE jsonb_set(
                    coalesce(backend_metadata, '{}'::jsonb),
                    '{upgradeApproval}', CAST(:approval AS jsonb), true
                ) - 'upgradeDeferral'
              END
            WHERE user_id = :user_id
              AND status = 'provisioned'
              -- The row is the authority for the owner and current pod. A stale
              -- route read must not be able to bind an approval to a replaced pod.
              AND hushh_id = :hushh_id
              AND :user_id = :owner_id
              AND (CAST(:browser_key AS text) IS NULL OR pod_key_id = CAST(:browser_key AS text))
              AND (CAST(:browser_epoch AS bigint) IS NULL OR placement_epoch = CAST(:browser_epoch AS bigint))
              AND coalesce(
                    backend_metadata->>'serviceUid',
                    external_agent_id,
                    backend_metadata->>'service',
                    'unknown'
                  ) = :pod_incarnation
              AND (
                    backend_metadata->'upgradeApproval' IS NULL
                    -- A retry of the same exact operation is idempotent, including
                    -- after the prior response was lost.
                    OR (
                      backend_metadata->'upgradeApproval'->>'releaseId' = :release_id
                      AND backend_metadata->'upgradeApproval'->>'idempotencyKey' = :idempotency_key
                      AND backend_metadata->'upgradeApproval'->>'targetImage' = :target_image
                    )
                    -- A terminal operation may be superseded by a later release;
                    -- an active or uncertain operation may never be overwritten.
                    OR (
                      backend_metadata->'upgradeApproval'->>'releaseId' <> :release_id
                      AND backend_metadata->'upgradeApproval'->>'status' IN
                        ('succeeded', 'failed')
                      AND backend_metadata->'upgradeApproval'->>'idempotencyKey' <> :idempotency_key
                    )
                  )
            RETURNING backend_metadata
            """


async def record_upgrade_approval(
    repo: PersonalAgentRegistryRepo, *, user_id: str, approval: dict
) -> Optional[dict]:
    """Atomically offer one exact release to the owner's current pod.

    The release predicate makes concurrent approval clicks converge on the
    first durable operation and refuses a stale release after the pod changes.
    The target image remains registry metadata; clients receive only the
    opaque release and operation identifiers.
    """
    from hushh_mcp.services.personal_agent_registry_repo import _validate_upgrade_approval

    approval = _validate_upgrade_approval(approval, user_id=user_id)
    release_id = approval["releaseId"].strip()
    idempotency_key = approval["idempotencyKey"].strip()
    target_image = approval["targetImage"].strip()
    response = await asyncio.to_thread(
        repo._db().execute_raw,
        APPROVAL_SQL,
        {
            "user_id": user_id,
            "release_id": release_id,
            "hushh_id": approval["hushhId"],
            "owner_id": approval["ownerId"],
            "pod_incarnation": approval["podIncarnation"],
            "idempotency_key": idempotency_key,
            "target_image": target_image,
            "browser_key": (approval.get("browserPlan") or {}).get("podKeyId"),
            "browser_epoch": (approval.get("browserPlan") or {}).get("placementEpoch"),
            "approval": json.dumps(approval),
        },
    )
    rows = list(getattr(response, "data", None) or [])
    if not rows:
        # A concurrent approval of this release has already won the
        # conditional write. Return that durable winner so every caller gets
        # the same operation id; never manufacture a local losing id.
        current = await repo.get(user_id)
        metadata = (current or {}).get("backend_metadata") or {}
        winner = metadata.get("upgradeApproval") if isinstance(metadata, dict) else None
        if isinstance(winner, dict):
            try:
                winner = _validate_upgrade_approval(winner, user_id=user_id)
                from hushh_mcp.services.pod_update_identity import approved_browser_plan

                browser = approved_browser_plan(winner)
                if browser is not None:
                    browser.require_owner(current, target_image)
            except ValueError:
                winner = None
        if (
            isinstance(winner, dict)
            and winner["releaseId"] == release_id
            and winner["hushhId"] == approval["hushhId"]
            and winner["podIncarnation"] == approval["podIncarnation"]
            and winner["idempotencyKey"] == idempotency_key
            and winner["targetImage"] == target_image
        ):
            return winner
        return None
    metadata = rows[0].get("backend_metadata") or {}
    stored = metadata.get("upgradeApproval") if isinstance(metadata, dict) else None
    if not isinstance(stored, dict):
        return None
    try:
        return dict(_validate_upgrade_approval(stored, user_id=user_id))
    except ValueError:
        return None
