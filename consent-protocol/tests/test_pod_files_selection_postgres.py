"""Real conditional publication: stale setup cannot change Files or other metadata."""

from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo, JobSuperseded
from hushh_mcp.services.pod_files.selection import publish_selection
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.test_pod_upgrade_lease_against_postgres import (  # noqa: F401 - existing disposable PG fixture
    engine,
    pg,
)

pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")


async def test_selection_is_bound_to_current_job_and_preserves_unrelated_metadata(pg, engine):  # noqa: F811
    pg.apply_file(
        Path(__file__).resolve().parents[1] / "db/migrations/parked/909_byoc_setup_jobs.sql"
    )

    class Client:
        def execute_raw(self, sql, params=None):
            with engine.begin() as connection:
                result = connection.execute(text(sql), params or {})
                return SimpleNamespace(
                    data=[dict(row) for row in result.mappings()] if result.returns_rows else []
                )

    db = Client()
    db.execute_raw(
        """INSERT INTO personal_agent_registry
        (user_id,hushh_id,status,deployment_target,user_cloud_project,user_cloud_bootstrap_sa,user_cloud_authorized_at,backend_metadata)
        VALUES ('files-owner','ha1_files','unprovisioned','user_gcp','owner-project','bootstrap',now(),CAST(:metadata AS jsonb))""",
        {"metadata": '{"endpoint":{"version":7}}'},
    )
    db.execute_raw(
        """INSERT INTO byoc_setup_jobs (user_id,job_id,project_id,status,stage,stages)
        VALUES ('files-owner','current-job','owner-project','running','proving',
        CAST(:stages AS jsonb))""",
        {"stages": '[{"stage":"files_selection","enabled":true,"version":1}]'},
    )
    args = dict(
        user_id="files-owner",
        job_id="current-job",
        project="owner-project",
        bootstrap_sa="bootstrap",
        db=db,
    )
    assert await publish_selection(**args)
    row = db.execute_raw(
        "SELECT backend_metadata FROM personal_agent_registry WHERE user_id='files-owner'"
    ).data[0]
    assert row["backend_metadata"]["endpoint"] == {"version": 7}
    assert row["backend_metadata"]["filesSetup"]["enabled"] is True
    for changed in (
        {"job_id": "stale-job"},
        {"project": "another-project"},
        {"bootstrap_sa": "another-identity"},
    ):
        with pytest.raises(JobSuperseded):
            await publish_selection(**{**args, **changed})
    db.execute_raw(
        "UPDATE personal_agent_registry SET status='provisioning' WHERE user_id='files-owner'"
    )
    with pytest.raises(JobSuperseded):
        await publish_selection(**args)

    jobs = ByocSetupJobRepo(client=db)
    cloud = dict(
        user_id="files-owner",
        job_id="current-job",
        project="owner-project",
        region="us-central1",
        bootstrap_sa="bootstrap",
        deployment_target="user_gcp",
        model_credential_mode="user_adc",
    )
    with pytest.raises(JobSuperseded):
        await jobs.record_proven_cloud(**cloud)
    db.execute_raw(
        "UPDATE personal_agent_registry SET status='unprovisioned' WHERE user_id='files-owner'"
    )
    assert await jobs.record_proven_cloud(**cloud) is False
    db.execute_raw(
        "UPDATE byoc_setup_jobs SET job_id='new-job',project_id='new-project' WHERE user_id='files-owner'"
    )
    with pytest.raises(JobSuperseded):
        await jobs.record_proven_cloud(**cloud)
    row = db.execute_raw(
        "SELECT user_cloud_project,backend_metadata FROM personal_agent_registry WHERE user_id='files-owner'"
    ).data[0]
    assert row["user_cloud_project"] == "owner-project"
    assert row["backend_metadata"]["endpoint"] == {"version": 7}
    db.execute_raw("DELETE FROM personal_agent_registry WHERE user_id='files-owner'")
    cloud.update(job_id="new-job", project="new-project")
    assert await jobs.record_proven_cloud(**cloud) is True
    parked = db.execute_raw(
        "SELECT project_id,stage,stages FROM byoc_setup_jobs WHERE user_id='files-owner'"
    ).data[0]
    assert parked["project_id"] == "new-project"
    assert parked["stage"] == "awaiting_agent_record"
    assert any(
        stage.get("stage") == "files_selection" and stage.get("enabled")
        for stage in parked["stages"]
    )


async def test_manual_cloud_setup_preserves_the_serving_assignment(pg, engine):  # noqa: F811
    from db.db_client import DatabaseClient
    from hushh_mcp.services.personal_agent_cloud_assignment import PodAssignmentPreserved
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

    client = DatabaseClient(engine=engine)
    client.execute_raw("""INSERT INTO personal_agent_registry (user_id,hushh_id,status)
        VALUES ('manual-cloud-owner','ha1_manual','unprovisioned')""")
    repo = PersonalAgentRegistryRepo(client=client)
    args = dict(
        user_id="manual-cloud-owner",
        project="owner-project",
        region="us-central1",
        bootstrap_sa="bootstrap",
        authorized=True,
        deployment_target="user_gcp",
        model_credential_mode="user_adc",
    )
    assert await repo.set_user_cloud(**args)
    client.execute_raw("""UPDATE personal_agent_registry SET status='provisioning'
        WHERE user_id='manual-cloud-owner'""")
    before = await repo.get("manual-cloud-owner")
    with pytest.raises(PodAssignmentPreserved):
        await repo.set_user_cloud(**{**args, "project": "another-project"})
    assert await repo.get("manual-cloud-owner") == before
    assert await repo.set_user_cloud(**args)
