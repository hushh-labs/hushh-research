"""Cloud publication and parking, serialized by the owning setup repository."""

import asyncio
import json
import uuid

from hushh_mcp.services.byoc_setup_job_service import (
    _JOBS,
    PARKED_STAGE,
    JobSuperseded,
    _now,
)


async def park_cloud(
    repo,
    *,
    user_id: str,
    project_id: str,
    region: str,
    bootstrap_sa: str,
    authorized: bool,
) -> None:
    """Keep a proven cloud for a person who has no agent record yet.

    The cloud step now comes first, so the common case is a cloud that is
    authorized before phone verification has minted the registry row it would
    attach to. Parking it here (the row that outlives everything but account
    deletion) lets ``register_pending`` attach it the moment the record exists,
    instead of refusing the person with a 409 that tells them to redo a step
    they cannot reach yet.
    """
    row = {
        "user_id": user_id,
        "job_id": uuid.uuid4().hex,
        "project_id": project_id,
        "status": "recorded",
        "stage": PARKED_STAGE,
        "stages": [
            {
                "stage": PARKED_STAGE,
                "at": _now(),
                "region": region,
                "bootstrap_sa": bootstrap_sa,
                "authorized": bool(authorized),
            }
        ],
        "error_code": None,
        "error_message": None,
        "updated_at": _now(),
    }
    current = await repo._current(user_id)
    if current:
        # Keep the running job's id: parking happens INSIDE that job's save step,
        # and a new id would make the job's own finish() read as superseded.
        row["job_id"] = str(current.get("job_id") or row["job_id"])
        if current.get("project_id") == project_id:
            row["stages"] = [
                stage
                for stage in (current.get("stages") or [])
                if stage.get("stage") == "files_selection"
            ] + row["stages"]
        repo._db().table(_JOBS).update(row).eq("user_id", user_id).execute()
    else:
        repo._db().table(_JOBS).insert(row).execute()


async def record_proven_cloud(
    repo,
    *,
    user_id: str,
    job_id: str,
    project: str,
    region: str,
    bootstrap_sa: str,
    deployment_target: str,
    model_credential_mode: str,
) -> bool:
    """Publish only the job that still owns setup; return whether it was parked.

    Hold the job row through both writes. A pre-read followed by an ordinary
    registry update lets a superseded OAuth attempt replace the new choice.
    Existing assignments and provisioning are never changed by this path.
    """
    result = await asyncio.to_thread(
        repo._db().execute_raw,
        """WITH job AS MATERIALIZED (
            SELECT * FROM byoc_setup_jobs
            WHERE user_id=:owner AND job_id=:job AND project_id=:project
              AND status='running' AND stage='proving' FOR UPDATE
        ), attached AS (
            UPDATE personal_agent_registry r
            SET user_cloud_project=:project, user_cloud_region=:region,
                user_cloud_bootstrap_sa=:bootstrap, user_cloud_authorized_at=now(),
                deployment_target=:target, model_credential_mode=:model_mode,
                updated_at=now()
            FROM job j WHERE r.user_id=j.user_id
              AND r.external_agent_id IS NULL
              AND r.status IN ('pending','unprovisioned','logical')
            RETURNING r.user_id
        ), parked AS (
            UPDATE byoc_setup_jobs j SET stage=:parked_stage,
                stages=j.stages || CAST(:parked_record AS jsonb), updated_at=now()
            FROM job selected WHERE j.user_id=selected.user_id
              AND j.job_id=selected.job_id
              AND NOT EXISTS (SELECT 1 FROM personal_agent_registry r WHERE r.user_id=j.user_id)
            RETURNING j.user_id
        ) SELECT false AS parked FROM attached
          UNION ALL SELECT true AS parked FROM parked""",
        {
            "owner": user_id,
            "job": job_id,
            "project": project,
            "region": region,
            "bootstrap": bootstrap_sa,
            "target": deployment_target,
            "model_mode": model_credential_mode,
            "parked_stage": PARKED_STAGE,
            "parked_record": json.dumps(
                [
                    {
                        "stage": PARKED_STAGE,
                        "at": _now(),
                        "region": region,
                        "bootstrap_sa": bootstrap_sa,
                        "authorized": True,
                    }
                ]
            ),
        },
    )
    if len(result.data or []) != 1:
        raise JobSuperseded("Cloud publication no longer owns this setup")
    return result.data[0]["parked"] is True
