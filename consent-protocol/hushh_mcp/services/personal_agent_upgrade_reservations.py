"""The existing registry upgrade lease and publication SQL behind its public facade.

Host snapshots stay with the registry. This port owns the same conditional writes,
including model maintenance's atomic plan claim; it creates no second journal.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

_CLAIM_UPGRADE_SQL = """
        UPDATE personal_agent_registry AS registry
        SET backend_metadata = jsonb_set(
                coalesce(backend_metadata, '{}'::jsonb),
                '{upgradeLease}',
                to_jsonb(CAST(:lease AS text)),
                true
            ) || CAST(:maintenance_metadata AS jsonb)
        WHERE user_id = :user_id
          AND status = 'provisioned'
          AND NOT EXISTS (
                SELECT 1 FROM jsonb_each(CAST(:observed_registry AS jsonb)) AS observed
                WHERE to_jsonb(registry)->observed.key IS DISTINCT FROM observed.value
              )
          AND user_cloud_authorized_at IS NOT DISTINCT FROM
                CAST(:observed_user_cloud_authorized_at AS timestamptz)
          AND (
                CAST(:publishing AS boolean)
                OR (
                    updated_at IS NOT DISTINCT FROM CAST(:observed_updated_at AS timestamptz)
                    AND backend_metadata IS NOT DISTINCT FROM CAST(:observed_backend_metadata AS jsonb)
                )
              )
          AND NOT EXISTS (
                SELECT 1 FROM jsonb_each(CAST(:observed_host_metadata AS jsonb)) AS observed
                WHERE COALESCE(backend_metadata->observed.key, 'null'::jsonb)
                      IS DISTINCT FROM observed.value
              )
          AND backend_metadata->>'upgradeLease' IS NULL
        RETURNING user_id
        """

_PUBLISH_UPGRADE_SQL = """
        UPDATE personal_agent_registry AS registry
        SET backend_metadata = (
                SELECT COALESCE(jsonb_object_agg(item.key, item.value), '{}'::jsonb)
                FROM jsonb_each(COALESCE(registry.backend_metadata, '{}'::jsonb)) AS item
                WHERE (item.key <> 'upgradeLease' OR CAST(:retain_lease AS boolean))
                  AND NOT (
                      CAST(:removed AS jsonb) ? item.key
                      AND CAST(:previous AS jsonb)->item.key IS NOT DISTINCT FROM item.value
                  )
            ) || CAST(:changes AS jsonb),
            liveness_mode = COALESCE(:liveness_mode, liveness_mode),
            model_credential_mode = COALESCE(:model_credential_mode, model_credential_mode),
            updated_at = NOW()
        WHERE user_id = :user_id AND status = 'provisioned'
          AND backend_metadata->>'upgradeLease' = :expected_lease
          AND NOT EXISTS (
                SELECT 1 FROM jsonb_each(CAST(:observed_registry AS jsonb)) AS observed
                WHERE to_jsonb(registry)->observed.key IS DISTINCT FROM observed.value
              )
          AND user_cloud_authorized_at IS NOT DISTINCT FROM
                CAST(:observed_user_cloud_authorized_at AS timestamptz)
          AND (
                CAST(:publishing AS boolean)
                OR (
                    updated_at IS NOT DISTINCT FROM CAST(:observed_updated_at AS timestamptz)
                    AND backend_metadata IS NOT DISTINCT FROM CAST(:observed_backend_metadata AS jsonb)
                )
              )
          AND NOT EXISTS (
                SELECT 1 FROM jsonb_each(CAST(:observed_host_metadata AS jsonb)) AS observed
                WHERE COALESCE(backend_metadata->observed.key, 'null'::jsonb)
                      IS DISTINCT FROM observed.value
              )
        RETURNING user_id
        """


def _metadata_delta(current: dict, previous: dict) -> tuple[dict, dict]:
    changes = {
        key: value
        for key, value in current.items()
        if key != "upgradeLease" and (key not in previous or previous[key] != value)
    }
    removed = {key: True for key in previous if key != "upgradeLease" and key not in current}
    return changes, removed


async def claim_image_upgrade(
    client: Any,
    *,
    user_id: str,
    target_image: str,
    observed: Optional[dict],
    model_enablement_plan: Optional[dict] = None,
) -> Optional[str]:
    """Take the single-flight lease for moving THIS pod to ``target_image``.

    One conditional UPDATE, so two hub workers cannot both win: the reconcile
    loop runs in every gunicorn worker, and on 2026-09-02 both replaced the
    founder's pod within thirty seconds of each other and each counted the
    other pod's copy failure, so the three-attempt cap was reached in two
    passes. The lease is a timestamp inside ``backend_metadata`` (no new
    column), cleared only after a known terminal result. Worker death and elapsed
    time never release admission: the provider may still be executing. The
    returned exact token owns result publication and uncertain retries remain
    reserved until provider reconciliation proves a terminal outcome.
    """
    from hushh_mcp.services.personal_agent_registry_repo import (
        _upgrade_snapshot_params,
        upgrade_host_snapshot,
    )

    snapshot = upgrade_host_snapshot(observed)
    if snapshot is None or snapshot["user_id"] != user_id or snapshot["status"] != "provisioned":
        return None
    observed_params = _upgrade_snapshot_params(snapshot)
    now = datetime.now(timezone.utc)
    lease = f"{now.isoformat()}|{uuid.uuid4().hex}|{target_image}"
    maintenance_metadata = {}
    if model_enablement_plan is not None:
        from hushh_mcp.services.azure_model_enablement import reservation_metadata

        maintenance_metadata = reservation_metadata(
            observed, user_id, target_image, lease, model_enablement_plan
        )
    result = client.execute_raw(
        _CLAIM_UPGRADE_SQL,
        {
            **observed_params,
            "user_id": user_id,
            "lease": lease,
            "maintenance_metadata": json.dumps(maintenance_metadata),
        },
    )
    return lease if result.data else None


async def record_image_upgrade(
    client: Any,
    *,
    user_id: str,
    backend_metadata: dict,
    expected_lease: str,
    previous_metadata: dict,
    observed: Optional[dict],
    liveness_mode: Optional[str] = None,
    retain_lease: bool = False,
    require_unchanged_metadata: bool = False,
    model_credential_mode: Optional[str] = None,
) -> bool:
    """Fence lease/host and optionally metadata; callers must separately prove
    executor termination and provider outcome before recovery."""
    from hushh_mcp.services.personal_agent_registry_repo import (
        _upgrade_snapshot_params,
        upgrade_host_snapshot,
    )

    if not isinstance(expected_lease, str) or not expected_lease:
        return False
    if model_credential_mode is not None:
        from hushh_mcp.services.azure_model_enablement import require_mode_publication

        if not require_mode_publication(
            observed,
            backend_metadata,
            expected_lease,
            model_credential_mode,
            retain_lease,
            require_unchanged_metadata,
        ):
            return False
    snapshot = upgrade_host_snapshot(observed)
    if snapshot is None or snapshot["user_id"] != user_id or snapshot["status"] != "provisioned":
        return False
    observed_params = _upgrade_snapshot_params(snapshot, publishing=not require_unchanged_metadata)
    changes, removed = _metadata_delta(backend_metadata, previous_metadata)
    result = client.execute_raw(
        _PUBLISH_UPGRADE_SQL,
        {
            **observed_params,
            "user_id": user_id,
            "expected_lease": expected_lease,
            "retain_lease": retain_lease,
            "removed": json.dumps(removed),
            "previous": json.dumps(previous_metadata),
            "changes": json.dumps(changes),
            "liveness_mode": liveness_mode,
            "model_credential_mode": model_credential_mode,
        },
    )
    return bool(result.data)
