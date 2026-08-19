"""Fleet-first reconciliation catches BOTH abandonment directions, and never
deletes anything without two independent guards.

The classification is pure and flag-free -- a report run cannot destroy. The
reclaim call deletes only when dry_run=False AND the founder flag is on; either
guard alone keeps it report-only. These pin exactly that.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.gcp_backend import _service_name
from hushh_mcp.services.pod_reconcile import (
    classify_fleet_registry_mismatch,
    reclaim_orphan,
)


def test_detects_lying_row_and_orphan_service():
    svc_a = _service_name("ha1_aaa")  # active row, but NOT in the fleet -> Direction A
    svc_b = _service_name("ha1_bbb")  # active row, IS in the fleet -> matched
    svc_orphan = "one-pod-orphan-xyz"  # in the fleet, no active row -> Direction B
    result = classify_fleet_registry_mismatch(
        fleet_service_names=[svc_b, svc_orphan],
        registry_rows=[
            {"hushh_id": "ha1_aaa", "status": "provisioned"},
            {"hushh_id": "ha1_bbb", "status": "connecting"},
            {"hushh_id": "ha1_ccc", "status": "unprovisioned"},  # not active -> ignored
        ],
    )
    a = {d["service"] for d in result["direction_a"]}
    b = {d["service"] for d in result["direction_b"]}
    assert svc_a in a  # a row claiming a host the fleet lacks
    assert svc_b not in a  # a matched row is not lying
    assert svc_orphan in b  # a billing service no active row claims
    assert svc_b not in b  # claimed -> not an orphan


def test_a_fully_consistent_fleet_reports_nothing():
    svc = _service_name("ha1_ok")
    result = classify_fleet_registry_mismatch(
        fleet_service_names=[svc],
        registry_rows=[{"hushh_id": "ha1_ok", "status": "provisioned"}],
    )
    assert result == {"direction_a": [], "direction_b": []}


@pytest.mark.asyncio
async def test_reclaim_is_report_only_by_default():
    calls: list = []

    async def _deleter(name):
        calls.append(name)

    r = await reclaim_orphan("one-pod-x", deleter=_deleter)  # dry_run defaults True
    assert r["deleted"] is False
    assert r["action"] == "would_reclaim"
    assert calls == []


@pytest.mark.asyncio
async def test_reclaim_refuses_without_the_flag_even_when_not_dry_run(monkeypatch):
    monkeypatch.delenv("PERSONAL_AGENT_FLEET_RECLAIM_ENABLED", raising=False)
    calls: list = []

    async def _deleter(name):
        calls.append(name)

    r = await reclaim_orphan("one-pod-x", deleter=_deleter, dry_run=False)
    assert r["deleted"] is False
    assert calls == []  # the flag alone is the second guard: still nothing deleted


@pytest.mark.asyncio
async def test_reclaim_deletes_only_with_both_guards_open(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_FLEET_RECLAIM_ENABLED", "1")
    calls: list = []

    async def _deleter(name):
        calls.append(name)

    r = await reclaim_orphan("one-pod-x", deleter=_deleter, dry_run=False)
    assert r["deleted"] is True
    assert calls == ["one-pod-x"]
