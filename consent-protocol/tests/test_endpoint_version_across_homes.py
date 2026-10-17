"""An agent's endpoint version keeps moving forward when its owner changes homes.

Live, 2026-10-05: the founder's agent moved from Google Cloud to Azure through a
detach. The detach kept the old endpoint record (Google URL, version 1) under
`detachedPlacements` and cleared the live one, so the Azure address was published
at version 1 too. A device pinned to {Google URL, version 1} refuses a different
URL at the same version, so the Mac's Puppy link could not follow the move.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from hushh_mcp.services.personal_agent_direct_admission import (
    _detached_endpoint_floor,
    _next_endpoint,
    record_endpoint,
)
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin
from tests.test_byoc_setup_job_azure_admission_postgres import HUSHH_ID, OWNER, _Client, _server
from tests.test_personal_agent_provision_after_detach_postgres import (
    _fresh_azure_home,
    _row,
    _seed,
)

GCP = "https://one-pod-ha1-example-uc.a.run.app"
AZURE = "https://ca-hussh-one-pod.example.eastus2.azurecontainerapps.io"
DETACHED = {"detachedPlacements": [{"backend_metadata": {"endpoint": {"url": GCP, "version": 1}}}]}


def test_no_detached_home_keeps_the_original_rules():
    assert _detached_endpoint_floor({}) == 0
    first = _next_endpoint({}, url=AZURE, pod_key_id="k1")
    assert first == {"version": 1, "url": AZURE, "podKeyId": "k1"}
    assert _next_endpoint(first, url=AZURE, pod_key_id="k1") == first
    assert _next_endpoint(first, url=AZURE, pod_key_id="k2")["version"] == 2


def test_a_new_home_starts_above_the_detached_one():
    floor = _detached_endpoint_floor(DETACHED)
    assert floor == 1
    assert _next_endpoint({}, url=AZURE, pod_key_id="k1", floor=floor)["version"] == 2


def test_a_home_already_published_at_the_old_version_is_advanced_once():
    floor = _detached_endpoint_floor(DETACHED)
    live = {"version": 1, "url": AZURE, "podKeyId": "k1"}
    advanced = _next_endpoint(live, url=AZURE, pod_key_id="k1", floor=floor)
    assert advanced == {"version": 2, "url": AZURE, "podKeyId": "k1"}
    assert _next_endpoint(advanced, url=AZURE, pod_key_id="k1", floor=floor) == advanced


@pytest.mark.parametrize(
    "metadata",
    [
        {"detachedPlacements": "bad"},
        {"detachedPlacements": [None, {"backend_metadata": None}, {"backend_metadata": {}}]},
        {"detachedPlacements": [{"backend_metadata": {"endpoint": {"version": "9"}}}]},
    ],
)
def test_malformed_detach_records_never_raise_the_floor(metadata):
    assert _detached_endpoint_floor(metadata) == 0


pg_only = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")


@pytest.fixture
def pg(monkeypatch):
    pytest.importorskip("psycopg2")
    server = _server(monkeypatch, last=953)
    try:
        yield server
    finally:
        server.stop()


@pg_only
def test_the_live_state_is_republished_above_the_pinned_version(pg: TempPostgres):
    _fresh_azure_home(pg)
    readiness = {"verified": True, "serviceUid": "svc", "podKeyId": "k1", "url": AZURE}
    metadata = {
        **DETACHED,
        "ingress": "direct",
        "url": AZURE,
        "serviceUid": "svc",
        "directReadiness": readiness,
        "endpoint": {"url": AZURE, "version": 1, "podKeyId": "k1"},
    }
    _seed(
        pg,
        "UPDATE personal_agent_registry SET status='provisioned', pod_key_id='k1',"
        " pod_pubkey='cHVi', backend_metadata=%s::jsonb WHERE user_id=%s",
        (json.dumps(metadata), OWNER),
    )
    db = SimpleNamespace(engine=_Client(pg)._engine)
    published = asyncio.run(
        record_endpoint(
            db, user_id=OWNER, hushh_id=HUSHH_ID, pod_key_id="k1",
            pod_public_key="cHVi", service_uid="svc", url=AZURE,
        )
    )  # fmt: skip
    assert published == {"version": 2, "url": AZURE, "podKeyId": "k1"}
    assert _row(pg)["backend_metadata"]["endpoint"]["version"] == 2
