"""The signed-request key pull can stamp a row whose attach is unfinished (953).

Live, 2026-10-05: the first Azure agent attached and reached `connecting`, then
every heartbeat drew 401. An agent that signs its requests (no Google token) is
unknown until the hub pulls its key, and the verifier throttles that pull by
stamping `backend_metadata.signingKeyPull`. The 917 guard admitted only heartbeat
observations while the attempt is `connecting`, so the stamp was refused
(`pull_claim_failed DatabaseExecutionError`) and the pull never ran. This runs the
real store's claim against the full dev chain; a control without 953 reproduces
the live refusal, and any other change during an attach is still refused.
"""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_request_identity_store import PodRequestIdentityStore
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin
from tests.test_byoc_setup_job_azure_admission_postgres import HUSHH_ID, OWNER, _Client, _server
from tests.test_personal_agent_provision_after_detach_postgres import (
    _fresh_azure_home,
    _intent,
    _row,
    _seed,
)

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")

RETAINED = "personal agent provision retained"
HOST = "https://ca-hussh-one-pod.example.eastus2.azurecontainerapps.io"


def _connecting(pg: TempPostgres) -> None:
    """A claimed Azure attach that has reached `connecting`, as dev's row did."""
    observed = _fresh_azure_home(pg)
    repo = PersonalAgentRegistryRepo(client=_Client(pg))
    assert asyncio.run(repo.claim_provision(observed=observed, intent=_intent(observed)))
    _seed(
        pg,
        "UPDATE personal_agent_registry SET status='connecting', backend_metadata="
        " jsonb_set(backend_metadata || jsonb_build_object('url', %s::text),"
        " '{provisionAttempt,phase}', '\"connecting\"') WHERE user_id=%s",
        (HOST, OWNER),
    )


def _claim(pg: TempPostgres, now_ms: int) -> bool:
    store = PodRequestIdentityStore(client=_Client(pg))
    return asyncio.run(store.claim_key_pull(hushh_id=HUSHH_ID, interval_ms=30_000, now_ms=now_ms))


@pytest.fixture
def pg(monkeypatch):
    server = _server(monkeypatch, last=953)
    try:
        yield server
    finally:
        server.stop()


def test_the_key_pull_stamps_a_connecting_attach_once_per_interval(pg):
    _connecting(pg)
    assert _claim(pg, now_ms=1_000_000)
    after = _row(pg)
    assert after["backend_metadata"]["signingKeyPull"] == 1_000_000
    assert after["backend_metadata"]["provisionAttempt"]["phase"] == "connecting"
    assert after["status"] == "connecting"
    assert not _claim(pg, now_ms=1_010_000)  # inside the 30 s slot
    assert _claim(pg, now_ms=1_031_000)


def test_any_other_change_during_an_attach_is_still_refused(pg):
    _connecting(pg)
    with pytest.raises(Exception, match=RETAINED):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata = backend_metadata"
            ' || \'{"signingKeyPull": 1, "image": "other"}\'::jsonb WHERE user_id=%s',
            (OWNER,),
        )
    with pytest.raises(Exception, match=RETAINED):
        pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata = backend_metadata"
            ' || \'{"signingKeyPull": "soon"}\'::jsonb WHERE user_id=%s',
            (OWNER,),
        )


def test_without_953_the_live_refusal_reproduces(monkeypatch):
    server = _server(monkeypatch, last=952)
    try:
        _connecting(server)
        with pytest.raises(Exception, match=RETAINED):
            _claim(server, now_ms=1_000_000)
    finally:
        server.stop()
