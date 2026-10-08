"""A person whose earlier agent was detached can attach their new home (952).

Live, 2026-10-05: the founder's test account had a Google agent detached
(`detach_placement`, kept host and data, kept the stable A2A route), then ran
Connect Azure to recorded. The attach was refused by the provision claim (946):
"requires reconciliation", because the detached row still carries its route and
`detachedPlacements`. This replays that exact sequence under the FULL dev chain
with the real detach, the real Azure publication and the real registry claim.
A negative control without 952 reproduces the live refusal.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from hushh_mcp.services.azure_cloud_publication import record_proven_azure_cloud
from hushh_mcp.services.azure_setup_plan import group_id
from hushh_mcp.services.byoc_setup_job_service import ByocSetupJobRepo
from hushh_mcp.services.personal_agent_placement_detach import detach_placement
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.user_cloud_service import user_cloud_from_row
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin
from tests.test_byoc_setup_job_azure_admission_postgres import (
    GROUP,
    HUSHH_ID,
    OWNER,
    SUB,
    TENANT,
    _Client,
    _server,
)

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")

ROUTE = f"https://a2a.hushh.ai/u/{HUSHH_ID}"
REFUSED = "personal agent provision requires reconciliation"


@pytest.fixture
def pg(monkeypatch):
    server = _server(monkeypatch, last=952)
    try:
        yield server
    finally:
        server.stop()


def _seed(pg: TempPostgres, sql: str, params: tuple = ()) -> None:
    """Write fixture state the guards would refuse outside a lifecycle step."""
    pg.execute("ALTER TABLE personal_agent_registry DISABLE TRIGGER USER")
    pg.execute(sql, params)
    pg.execute("ALTER TABLE personal_agent_registry ENABLE TRIGGER USER")


def _google_agent(pg: TempPostgres) -> None:
    _seed(
        pg,
        "INSERT INTO personal_agent_registry(user_id,hushh_id,phone_e164_hash,status,"
        " backend,external_agent_id,a2a_route,deployment_target,model_credential_mode,"
        " user_cloud_project,user_cloud_region,user_cloud_bootstrap_sa,"
        " user_cloud_authorized_at,backend_metadata) VALUES (%s,%s,'sha256:phone',"
        " 'provisioned','user_gcp','one-pod-x',%s,'user_gcp','user_adc','owner-project-1',"
        " 'us-central1','one-bootstrap@owner-project-1.iam.gserviceaccount.com',now(),"
        ' \'{"url":"https://one-pod-x.run.app"}\'::jsonb)',
        (OWNER, HUSHH_ID, ROUTE),
    )


def _row(pg: TempPostgres) -> dict:
    [row] = (
        _Client(pg)
        .execute_raw(
            "SELECT to_jsonb(r) AS row FROM personal_agent_registry r WHERE user_id=:o",
            {"o": OWNER},
        )
        .data
    )
    return row["row"]


def _detach_then_set_up_azure(pg: TempPostgres) -> dict:
    client = _Client(pg)
    [provisioned] = client.execute_raw(
        "SELECT * FROM personal_agent_registry WHERE user_id=:o", {"o": OWNER}
    ).data
    assert asyncio.run(detach_placement(row=provisioned, reason="move home", db=client))
    repo = ByocSetupJobRepo(client=client)
    assert asyncio.run(repo.start(user_id=OWNER, job_id="job-1", project_id=group_id(SUB, GROUP)))
    pg.execute("UPDATE byoc_setup_jobs SET stage='proving' WHERE user_id=%s", (OWNER,))
    asyncio.run(
        record_proven_azure_cloud(
            repo, user_id=OWNER, job_id="job-1", tenant_id=TENANT, subscription_id=SUB,
            resource_group=GROUP, location="eastus2", model_credential_mode="user_azure_mi",
        )
    )  # fmt: skip
    pg.execute("UPDATE byoc_setup_jobs SET status='recorded' WHERE user_id=%s", (OWNER,))
    return _row(pg)


def _intent(observed: dict) -> dict:
    """The provisioning service's own intent shape for this row."""
    cloud = user_cloud_from_row(observed)
    assert cloud is not None
    intent = {
        "user_id": OWNER,
        "hushh_id": observed["hushh_id"],
        "phone_e164_hash": observed["phone_e164_hash"],
        "deployment_target": cloud.deployment_target,
        "model_credential_mode": cloud.model_credential_mode,
        "user_cloud_project": cloud.project,
        "user_cloud_region": cloud.region,
        "user_cloud_bootstrap_sa": cloud.bootstrap_sa,
    }
    return {key: value for key, value in intent.items() if value is not None}


def _claim_raw(pg: TempPostgres, observed: dict) -> None:
    """The claim SQL itself, so a refusal keeps its own message."""
    _Client(pg).execute_raw(
        "SELECT public.claim_personal_agent_provision(:o,:a,CAST(:obs AS jsonb),CAST(:i AS jsonb))",
        {
            "o": OWNER,
            "a": "0" * 32,
            "obs": json.dumps(observed),
            "i": json.dumps(_intent(observed)),
        },
    )


def test_a_detached_person_can_attach_their_new_azure_home(pg):
    _google_agent(pg)
    observed = _detach_then_set_up_azure(pg)
    assert observed["a2a_route"] == ROUTE and observed["deployment_target"] == "user_azure"

    repo = PersonalAgentRegistryRepo(client=_Client(pg))
    reservation = asyncio.run(repo.claim_provision(observed=observed, intent=_intent(observed)))

    assert reservation["phase"] == "reserved"
    after = _row(pg)
    assert after["status"] == "provisioning"
    assert after["a2a_route"] == ROUTE
    assert after["user_cloud_resource_group"] == GROUP
    [detached] = after["backend_metadata"]["detachedPlacements"]
    assert detached["deployment_target"] == "user_gcp"
    assert detached["user_cloud_project"] == "owner-project-1"


def _fresh_azure_home(pg: TempPostgres) -> dict:
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,phone_e164_hash,status)"
        " VALUES (%s,%s,'sha256:phone','unprovisioned')",
        (OWNER, HUSHH_ID),
    )
    client = _Client(pg)
    repo = ByocSetupJobRepo(client=client)
    assert asyncio.run(repo.start(user_id=OWNER, job_id="job-1", project_id=group_id(SUB, GROUP)))
    pg.execute("UPDATE byoc_setup_jobs SET stage='proving' WHERE user_id=%s", (OWNER,))
    asyncio.run(
        record_proven_azure_cloud(
            repo, user_id=OWNER, job_id="job-1", tenant_id=TENANT, subscription_id=SUB,
            resource_group=GROUP, location="eastus2", model_credential_mode="user_azure_mi",
        )
    )  # fmt: skip
    pg.execute("UPDATE byoc_setup_jobs SET status='recorded' WHERE user_id=%s", (OWNER,))
    return _row(pg)


def test_a_first_azure_home_can_be_claimed(pg):
    """948's coordinate CHECK judges the claim's proposed insert row too."""
    observed = _fresh_azure_home(pg)
    repo = PersonalAgentRegistryRepo(client=_Client(pg))
    assert asyncio.run(repo.claim_provision(observed=observed, intent=_intent(observed)))
    after = _row(pg)
    assert (after["status"], after["user_cloud_subscription_id"]) == ("provisioning", SUB)


def test_without_952_a_first_azure_home_is_refused(monkeypatch):
    server = _server(monkeypatch, last=951)
    try:
        observed = _fresh_azure_home(server)
        with pytest.raises(Exception, match="user_azure_needs_coordinates_check"):
            _claim_raw(server, observed)
    finally:
        server.stop()


def test_a_route_the_detach_did_not_record_is_still_refused(pg):
    _google_agent(pg)
    _detach_then_set_up_azure(pg)
    _seed(
        pg,
        "UPDATE personal_agent_registry SET a2a_route='https://elsewhere.example/u/x'"
        " WHERE user_id=%s",
        (OWNER,),
    )
    with pytest.raises(Exception, match=REFUSED):
        _claim_raw(pg, _row(pg))


def test_a_route_without_any_detach_record_is_still_refused(pg):
    _seed(
        pg,
        "INSERT INTO personal_agent_registry(user_id,hushh_id,phone_e164_hash,status,a2a_route)"
        " VALUES (%s,%s,'sha256:phone','unprovisioned',%s)",
        (OWNER, HUSHH_ID, ROUTE),
    )
    with pytest.raises(Exception, match=REFUSED):
        _claim_raw(pg, _row(pg))


def test_a_malformed_detach_record_is_still_refused(pg):
    _google_agent(pg)
    _detach_then_set_up_azure(pg)
    _seed(
        pg,
        "UPDATE personal_agent_registry SET backend_metadata="
        " jsonb_build_object('detachedPlacements', '{}'::jsonb) WHERE user_id=%s",
        (OWNER,),
    )
    with pytest.raises(Exception, match=REFUSED):
        _claim_raw(pg, _row(pg))


def test_without_952_the_live_refusal_reproduces(monkeypatch):
    """Negative control: the chain through 951 refuses exactly as dev did."""
    server = _server(monkeypatch, last=951)
    try:
        _google_agent(server)
        observed = _detach_then_set_up_azure(server)
        with pytest.raises(Exception, match=REFUSED):
            _claim_raw(server, observed)
    finally:
        server.stop()
