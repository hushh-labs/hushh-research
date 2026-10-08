"""The external-ingress promotion satisfies the exact predicate the endpoint enforces.

Runs `promote_external_ingress` against the full dev chain on a provisioned Azure
row, then asks `direct_owner_matches` (the rule `record_endpoint` applies under the
row lock) whether the owner's app may now be given the endpoint.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from hushh_mcp.services.personal_agent_direct_admission import (
    direct_owner_matches,
    promote_external_ingress,
)
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin
from tests.test_byoc_setup_job_azure_admission_postgres import HUSHH_ID, OWNER, _Client, _server
from tests.test_personal_agent_provision_after_detach_postgres import (
    _fresh_azure_home,
    _row,
    _seed,
)

psycopg2 = pytest.importorskip("psycopg2")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")

URL = "https://ca-hussh-one-pod.example.eastus2.azurecontainerapps.io"
POD = {"pod_key_id": "pod_key_1", "pod_public_key": "cHVibGlj", "service_uid": "svc-1"}


@pytest.fixture
def pg(monkeypatch):
    server = _server(monkeypatch, last=953)
    try:
        yield server
    finally:
        server.stop()


def _provisioned(pg: TempPostgres, ingress: str) -> None:
    _fresh_azure_home(pg)
    metadata = {"ingress": ingress, "url": URL, "serviceUid": POD["service_uid"]}
    _seed(
        pg,
        "UPDATE personal_agent_registry SET status='provisioned', pod_key_id=%s, pod_pubkey=%s,"
        " backend_metadata=%s::jsonb WHERE user_id=%s",
        (POD["pod_key_id"], POD["pod_public_key"], json.dumps(metadata), OWNER),
    )


def _promote(pg: TempPostgres, **overrides: str) -> bool:
    fields = {
        "user_id": OWNER,
        "hushh_id": HUSHH_ID,
        "service_uid": POD["service_uid"],
        "pod_key_id": POD["pod_key_id"],
        "url": URL,
        "verified_at": "2026-10-05T09:00:00+00:00",
        **overrides,
    }
    return asyncio.run(promote_external_ingress(_Client(pg), **fields))


def _endpoint_admits(pg: TempPostgres) -> bool:
    return direct_owner_matches(
        _row(pg), hushh_id=HUSHH_ID, pod_public_key=POD["pod_public_key"], url=URL,
        pod_key_id=POD["pod_key_id"], service_uid=POD["service_uid"],
    )  # fmt: skip


def test_an_external_pod_becomes_endpoint_ready_in_one_write(pg):
    _provisioned(pg, "external")
    assert not _endpoint_admits(pg)
    assert _promote(pg)
    after = _row(pg)["backend_metadata"]
    assert after["ingress"] == "direct"
    assert after["directReadiness"]["url"] == URL
    assert _endpoint_admits(pg)


def test_a_private_pod_is_never_promoted(pg):
    """`internal` stays the operator's transition (dev-pod-first-light runbook)."""
    _provisioned(pg, "internal")
    assert not _promote(pg)
    assert "directReadiness" not in _row(pg)["backend_metadata"]


@pytest.mark.parametrize(
    "overrides",
    [{"pod_key_id": "pod_key_2"}, {"service_uid": "svc-2"}, {"url": URL + ".evil"}],
)
def test_a_receipt_for_another_incarnation_is_refused(pg, overrides):
    _provisioned(pg, "external")
    assert not _promote(pg, **overrides)
    assert _row(pg)["backend_metadata"]["ingress"] == "external"
