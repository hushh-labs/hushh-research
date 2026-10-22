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


async def update_job_progress(
    repo,
    *,
    user_id: str,
    job_id: str,
    data: dict,
    running_only: bool = False,
    expected_stages: list | None = None,
) -> bool:
    """Publish under owner-first locks; never replace a concurrently extended journal."""
    if set(data) - {"stage", "stages", "status", "error_code", "error_message"}:
        raise ValueError("Unsupported setup progress fields")
    if "stages" in data and expected_stages is None:
        raise ValueError("Replacing setup stages requires an observed journal")
    event = [{"stage": data["stage"], "at": _now()}] if "stage" in data else []
    result = await asyncio.to_thread(
        repo._db().execute_raw,
        """WITH owner_lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtextextended(:owner,171))
        ), erasure_lock AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtextextended(:owner,198)) FROM owner_lock
        ), job AS MATERIALIZED (
            SELECT j.user_id FROM byoc_setup_jobs j CROSS JOIN erasure_lock
            WHERE j.user_id=:owner AND j.job_id=:job
              AND (NOT CAST(:running_only AS boolean) OR j.status='running')
              AND (CAST(:expected AS jsonb) IS NULL OR j.stages=CAST(:expected AS jsonb))
            FOR UPDATE OF j
        ) UPDATE byoc_setup_jobs j SET
            stage=CASE WHEN p.value ? 'stage' THEN p.value->>'stage' ELSE j.stage END,
            stages=CASE WHEN p.value ? 'stages' THEN p.value->'stages'
                WHEN p.value ? 'stage' THEN j.stages || CAST(:event AS jsonb)
                ELSE j.stages END,
            status=CASE WHEN p.value ? 'status' THEN p.value->>'status' ELSE j.status END,
            error_code=CASE WHEN p.value ? 'error_code' THEN p.value->>'error_code'
                ELSE j.error_code END,
            error_message=CASE WHEN p.value ? 'error_message' THEN p.value->>'error_message'
                ELSE j.error_message END,
            updated_at=now()
        FROM job selected, (SELECT CAST(:patch AS jsonb) AS value) p
        WHERE j.user_id=selected.user_id AND j.job_id=:job RETURNING j.job_id""",
        {
            "owner": user_id,
            "job": job_id,
            "running_only": running_only,
            "expected": json.dumps(expected_stages) if expected_stages is not None else None,
            "event": json.dumps(event),
            "patch": json.dumps(data),
        },
    )
    return bool(result.data)


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
