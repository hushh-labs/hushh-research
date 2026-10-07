"""The widening's registry writes, against the real dev migration chain and its triggers.

`claim_widen_attempt`, `record_widen_blocker`, `clear_direct_ingress_blocker` and
`promote_internal_to_external` each run on a provisioned Google own-cloud row seeded
the way production writes it. `promote_internal_to_external` must only ever produce
`external` (never `direct` or a readiness receipt), and every write must refuse a
replaced pod, a blocked row, an erasure and an update in flight.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from hushh_mcp.services import owner_direct_widen as widen
from hushh_mcp.services.personal_agent_direct_admission import promote_internal_to_external
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin
from tests.test_byoc_setup_job_azure_admission_postgres import HUSHH_ID, OWNER, _Client, _server
from tests.test_personal_agent_provision_after_detach_postgres import _google_agent, _row, _seed

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")

URL = "https://one-pod-x.run.app"


@pytest.fixture
def pg(monkeypatch):
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    server = _server(monkeypatch, last=953)
    try:
        yield server
    finally:
        server.stop()


def _hub_only(pg: TempPostgres, **extra: object) -> dict:
    _google_agent(pg)
    metadata = {
        "ingress": "internal",
        "tenancy": "user-owned",
        "url": URL,
        "service": "one-pod-x",
        "serviceUid": "svc-1",
        "observed": {"aiSelection": {"version": 1, "providers": []}},
        **extra,
    }
    _seed(
        pg,
        "UPDATE personal_agent_registry SET pod_key_id='pod_key_1', pod_pubkey='cHVibGlj',"
        " backend_metadata=%s::jsonb WHERE user_id=%s",
        (json.dumps(metadata), OWNER),
    )
    return _row(pg)


def _promote(pg: TempPostgres, **overrides: str) -> bool:
    fields = {"user_id": OWNER, "hushh_id": HUSHH_ID, "service_uid": "svc-1", "url": URL}
    return asyncio.run(promote_internal_to_external(_Client(pg), **{**fields, **overrides}))


def test_a_widened_agent_is_recorded_external_and_never_direct(pg):
    row = _hub_only(pg, directIngressWiden={"attempts": 1})
    assert widen.widen_due(row) is not None
    assert _promote(pg)
    after = _row(pg)["backend_metadata"]
    assert after["ingress"] == "external"
    assert "directReadiness" not in after and "directIngressWiden" not in after


@pytest.mark.parametrize(
    "overrides", [{"service_uid": "svc-2"}, {"url": URL + ".evil"}, {"hushh_id": "other"}]
)
def test_a_promotion_for_another_incarnation_is_refused(pg, overrides):
    _hub_only(pg)
    assert not _promote(pg, **overrides)
    assert _row(pg)["backend_metadata"]["ingress"] == "internal"


@pytest.mark.parametrize(
    "extra",
    [
        {"directIngressBlocker": {"code": "ORG_POLICY_REFUSES_PUBLIC_INVOKER"}},
        {"upgradeLease": "2026-10-06T00:00:00+00:00|lease"},
    ],
)
def test_a_blocked_or_updating_agent_is_never_promoted(pg, extra):
    _hub_only(pg, **extra)
    assert not _promote(pg)
    assert _row(pg)["backend_metadata"]["ingress"] == "internal"


def test_one_claim_wins_and_the_second_sees_the_new_marker(pg):
    row = _hub_only(pg)
    due = widen.widen_due(row)
    assert asyncio.run(widen.claim_widen_attempt(row, due, db=_Client(pg)))
    # A second worker holding the same stale row loses the compare-and-set.
    assert not asyncio.run(widen.claim_widen_attempt(row, due, db=_Client(pg)))
    assert _row(pg)["backend_metadata"]["directIngressWiden"]["attempts"] == 1


def test_a_blocker_is_recorded_once_and_the_owners_retry_clears_it(pg):
    row = _hub_only(pg, directIngressWiden={"attempts": 2})
    due = widen.widen_due(row)
    assert asyncio.run(widen.record_widen_blocker(due, 412, db=_Client(pg)))
    blocked = _row(pg)["backend_metadata"]
    assert blocked["directIngressBlocker"]["code"] == "ORG_POLICY_REFUSES_PUBLIC_INVOKER"
    assert blocked["ingress"] == "internal"
    assert not asyncio.run(widen.record_widen_blocker(due, 412, db=_Client(pg)))
    assert widen.widen_due(_row(pg)) is None
    assert asyncio.run(widen.clear_direct_ingress_blocker(OWNER, db=_Client(pg)))
    cleared = _row(pg)["backend_metadata"]
    assert "directIngressBlocker" not in cleared and "directIngressWiden" not in cleared
    assert widen.widen_due(_row(pg)) is not None
    assert not asyncio.run(widen.clear_direct_ingress_blocker(OWNER, db=_Client(pg)))


def test_an_erasure_refuses_every_write(pg):
    row = _hub_only(pg)
    due = widen.widen_due(row)
    _seed(
        pg,
        "UPDATE personal_agent_registry SET backend_metadata = backend_metadata ||"
        " '{\"erasure\":{}}'::jsonb WHERE user_id=%s",
        (OWNER,),
    )
    client = _Client(pg)
    assert not asyncio.run(widen.claim_widen_attempt(row, due, db=client))
    assert not asyncio.run(widen.record_widen_blocker(due, 412, db=client))
    assert not _promote(pg)
    assert _row(pg)["backend_metadata"]["ingress"] == "internal"
