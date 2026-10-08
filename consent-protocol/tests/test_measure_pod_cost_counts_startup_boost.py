"""The pod cost meter prices cold starts at the boosted CPU Google actually bills.

WHY THIS EXISTS
Every pod is rendered with startup CPU boost on, and Google bills a limit of up
to 1 vCPU at 2 vCPU "during instance startup time and for 10 seconds after"
(Cloud Run CPU docs, checked 2026-10-06). `measure_pod_cost.py` multiplied
billable seconds by the unboosted rate, so a 76 s cold start on a 0.5 vCPU pod
read as 38 vCPU-s when it bills as 2 x (76 + 10) = 172. Cold-start-heavy use
therefore read about 4.5x low on CPU. These tests pin the worked example from
the pod economics fact sheet with fixed inputs, and the parsers against the
shape the live Monitoring API returns.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
_PATH = REPO_ROOT / "scripts/ops/measure_pod_cost.py"
_SPEC = importlib.util.spec_from_file_location("measure_pod_cost", _PATH)
assert _SPEC is not None and _SPEC.loader is not None
cost = importlib.util.module_from_spec(_SPEC)
sys.modules["measure_pod_cost"] = cost
_SPEC.loader.exec_module(cost)


def _measurement(**overrides: Any) -> Any:
    fields: dict[str, Any] = {
        "service": "one-pod-test",
        "project": "test-project",
        "window": "24h",
        "billable_seconds": 76.0,
        "points": 2,
        "vcpu": 0.5,
        "gib": 1.0,
        "cold_starts": 1,
        "startup_seconds": 76.0,
        "startup_boost": True,
    }
    fields.update(overrides)
    return cost.Measurement(**fields)


def test_a_76_second_cold_start_bills_172_vcpu_seconds_not_38() -> None:
    m = _measurement()
    assert m.billable_seconds * m.vcpu == pytest.approx(38.0)
    assert m.vcpu_seconds == pytest.approx(2 * (76 + 10))
    assert m.vcpu_seconds == pytest.approx(172.0)
    assert m.gib_seconds == pytest.approx(76.0)
    # 172 x $0.000024 + 76 x $0.0000025, the fact sheet's $0.00432 per cold start.
    assert m.usd == pytest.approx(0.004318)
    assert m.unboosted_usd == pytest.approx(76 * (0.5 * 0.000024 + 0.0000025))


def test_billable_time_beyond_the_boost_window_bills_at_the_limit() -> None:
    # Cold start plus a 14 s first turn: the 10 s tail overlaps the turn, so only
    # 4 s is left at 0.5 vCPU. The fact sheet's isolated one-turn figure is 174.
    m = _measurement(billable_seconds=90.0)
    assert m.vcpu_seconds == pytest.approx(174.0)
    assert m.gib_seconds == pytest.approx(90.0)


def test_one_vcpu_limit_is_also_boosted_to_two() -> None:
    m = _measurement(vcpu=1.0)
    assert m.vcpu_seconds == pytest.approx(172.0)


def test_boost_off_or_no_start_keeps_the_unboosted_reading() -> None:
    assert _measurement(startup_boost=False).vcpu_seconds == pytest.approx(38.0)
    no_start = _measurement(cold_starts=0, startup_seconds=0.0)
    assert no_start.vcpu_seconds == pytest.approx(38.0)
    assert no_start.usd == pytest.approx(no_start.unboosted_usd)


def test_a_limit_above_one_vcpu_is_not_priced_with_a_guessed_boost() -> None:
    m = _measurement(vcpu=2.0)
    assert m.boosted_vcpu is None
    assert m.vcpu_seconds == pytest.approx(152.0)
    assert "NOT PRICED" in cost.render(m)


def test_cold_starts_are_summed_from_the_startup_latency_distribution() -> None:
    # Shape of `run.googleapis.com/container/startup_latencies` as the v3 API
    # returned it for hushh-byoc-test: an empty distribution for a quiet minute,
    # count as a string and mean in milliseconds for a minute with a start.
    payload = {
        "timeSeries": [
            {
                "points": [
                    {"value": {"distributionValue": {}}},
                    {"value": {"distributionValue": {"count": "1", "mean": 76000.0}}},
                ]
            },
            {"points": [{"value": {"distributionValue": {"count": "2", "mean": 45000.0}}}]},
        ]
    }
    assert cost.sum_cold_starts(payload) == (3, pytest.approx(166.0))
    assert cost.sum_cold_starts({}) == (0, 0.0)


def test_billable_points_parser_is_unchanged() -> None:
    payload = {
        "timeSeries": [
            {"points": [{"value": {"doubleValue": 60.0}}, {"value": {"int64Value": "16"}}]},
            {"points": [{"value": {}}]},
        ]
    }
    assert cost.sum_billable_points(payload) == (pytest.approx(76.0), 2)


def test_tier_and_boost_are_read_off_the_service() -> None:
    service: dict[str, Any] = {
        "spec": {
            "template": {
                "metadata": {"annotations": {"run.googleapis.com/startup-cpu-boost": "true"}},
                "spec": {
                    "containers": [{"resources": {"limits": {"cpu": "500m", "memory": "1Gi"}}}]
                },
            }
        }
    }
    assert cost.parse_service_tier(service) == (0.5, 1.0, True)
    service["spec"]["template"]["metadata"]["annotations"] = {}
    assert cost.parse_service_tier(service) == (0.5, 1.0, False)


def test_main_prices_the_cold_start_it_reads(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cost, "read_tier", lambda *_: (0.5, 1.0, True))
    monkeypatch.setattr(cost, "read_billable_seconds", lambda *_: (76.0, 2))
    monkeypatch.setattr(cost, "read_cold_starts", lambda *_: (1, 76.0))
    monkeypatch.setattr(
        sys, "argv", ["measure_pod_cost.py", "--project", "p", "--service", "s", "--json"]
    )
    assert cost.main() == 0
    out = json.loads(capsys.readouterr().out)
    assert out["vcpu_seconds"] == pytest.approx(172.0)
    assert out["usd"] == pytest.approx(0.004318)
