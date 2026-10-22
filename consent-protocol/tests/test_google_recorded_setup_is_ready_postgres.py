"""A real Google setup, once recorded, passes the real attach readiness check.

``finish_recorded_setup`` attaches only when ``owner_cloud_ready_to_attach`` (the
gate's ``_reserved_byoc_ready``) says the reservation is the proven one-click
setup. Every unit test of the attach fakes that answer, so nothing showed that the
rows a real Google setup leaves behind satisfy it: registry ``pending`` with the
proven cloud, ``job.project_id == cloud.project``, the job ``recorded``, and, with
Files, the published selection naming this job. If they did not, every Google setup
would quietly record ``SETUP_NOT_READY``. Here the real repositories write those rows
on a real PostgreSQL (migrations 900-950 verbatim, guard triggers included) in the
order ``run_setup_job`` writes them, and the real check reads them.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.ai_connection_gate import owner_cloud_ready_to_attach
from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo
from hushh_mcp.services.owner_cloud_attach import BLOCKED_NOT_READY, attach_blocker
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_files.selection import publish_selection
from tests import standby_postgres_support as support
from tests.pkm_conformance.postgres_harness import find_pg_bin
from tests.standby_postgres_support import HUSHH_ID, OWNER

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")

PROJECT = "owner-project"
BOOTSTRAP = f"one-bootstrap@{PROJECT}.iam.gserviceaccount.com"
JOB = "a" * 32


@pytest.fixture(scope="module")
def server():
    yield from support.start_server()


@pytest.fixture
def client(server):
    from db.db_client import DatabaseClient

    support.reset(server)
    server.execute("DELETE FROM byoc_setup_jobs")
    # register_pending's shape: a phone-verified person with no placement yet.
    server.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status) VALUES (%s,%s,'pending')",
        (OWNER, HUSHH_ID),
    )
    return DatabaseClient(engine=support.Db(server).engine)


async def _run_google_setup(client, *, files_enabled: bool) -> ByocSetupJobRepo:
    """The record-keeping writes of ``run_setup_job`` and the save route, in order."""
    jobs = ByocSetupJobRepo(client=client)
    assert await jobs.start(
        user_id=OWNER, job_id=JOB, project_id=PROJECT, files_enabled=files_enabled
    )
    for stage in ("creating_project", "linking_billing", "enabling_apis", "settling_grant"):
        await jobs.advance(user_id=OWNER, job_id=JOB, stage=stage)
    await jobs.advance(user_id=OWNER, job_id=JOB, stage="proving")
    parked = await jobs.record_proven_cloud(
        user_id=OWNER,
        job_id=JOB,
        project=PROJECT,
        region="us-central1",
        bootstrap_sa=BOOTSTRAP,
        deployment_target="user_gcp",
        model_credential_mode="user_adc",
    )
    assert parked is False  # the record existed, so the cloud went straight onto it
    if files_enabled:
        assert await publish_selection(
            user_id=OWNER, job_id=JOB, project=PROJECT, bootstrap_sa=BOOTSTRAP, db=client
        )
    await jobs.finish(user_id=OWNER, job_id=JOB, status="recorded")
    return jobs


@pytest.mark.parametrize("files_enabled", [False, True])
async def test_a_recorded_google_setup_is_ready_to_attach(client, files_enabled):
    jobs = await _run_google_setup(client, files_enabled=files_enabled)
    registry = PersonalAgentRegistryRepo(client=client)
    row = await registry.get(OWNER)

    ready, cloud = await owner_cloud_ready_to_attach(OWNER, row, registry, jobs)

    assert ready is True
    assert cloud.project == PROJECT and cloud.is_ready_to_provision
    assert await attach_blocker(OWNER, row, job_id=JOB, registry=registry, setup_jobs=jobs) is None


async def test_a_selection_naming_another_job_is_not_ready(client):
    jobs = await _run_google_setup(client, files_enabled=True)
    client.execute_raw(
        "UPDATE personal_agent_registry SET backend_metadata = jsonb_set(backend_metadata,"
        " '{filesSetup,setupJobId}', '\"another-job\"') WHERE user_id = :owner",
        {"owner": OWNER},
    )
    registry = PersonalAgentRegistryRepo(client=client)
    row = await registry.get(OWNER)

    assert (await owner_cloud_ready_to_attach(OWNER, row, registry, jobs))[0] is False
    assert (
        await attach_blocker(OWNER, row, job_id=JOB, registry=registry, setup_jobs=jobs)
        == BLOCKED_NOT_READY
    )
