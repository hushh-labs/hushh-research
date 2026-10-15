"""Buyer journey replay at the API level: ask, review, deny, allow, terms, checkout
once, stop before paying, cancel, no grant, one request per listed packet."""

import json

import pytest

from hushh_eval.drive_packets import journey as journey_module
from hushh_eval.drive_packets.journey import FakeBuyerServer, planned_calls, run_journey

FILES = ["d1", "d2"]


async def journey(server, **kwargs):
    return await run_journey(
        server,
        owner_ref="00000000-0000-0000-0000-000000000001",
        purpose="my bank statements",
        period=("2026-09-01", "2026-10-09"),
        **kwargs,
    )


async def test_contract_compliant_server_passes_every_step():
    result = await journey(FakeBuyerServer(files=FILES), expected_include=set(FILES))
    assert result.passed, [step for step in result.steps if not step.ok]
    names = [step.name for step in result.steps]
    assert names.index("checkout_idempotent") < names.index("cancel_before_paying")
    assert "pay" not in names


async def test_stale_digest_accepted_is_caught():
    result = await journey(FakeBuyerServer(files=FILES, stale_digest_accepted=True))
    failed = {step.name for step in result.steps if not step.ok}
    assert "stale_digest_refused" in failed


async def test_second_checkout_session_is_caught():
    result = await journey(FakeBuyerServer(files=FILES, double_session=True))
    failed = {step.name for step in result.steps if not step.ok}
    assert failed == {"checkout_idempotent"}


async def test_duplicate_package_files_or_label_mismatch_are_caught():
    result = await journey(FakeBuyerServer(files=["d1", "d1"]), expected_include={"d1", "d3"})
    failed = {step.name for step in result.steps if not step.ok}
    assert {"package_files_distinct", "package_matches_labels"} <= failed


def test_dry_run_plan_stops_before_paying():
    calls = planned_calls("owner-ref")
    stop = next(index for index, call in enumerate(calls) if call.startswith("STOP"))
    assert any("checkout" in call for call in calls[:stop])
    assert all("checkout" not in call for call in calls[stop + 1 :])


def test_live_journey_refuses_live_stripe_before_any_call(monkeypatch, capsys):
    from hushh_eval.drive_packets import journey

    monkeypatch.setenv("DRIVE_PACKET_EVAL_LIVE", "1")
    assert journey.main(["--live"], stripe_mode=lambda: "live") == 2
    assert "not_stripe_test_mode" in capsys.readouterr().out
    assert journey.main([], stripe_mode=lambda: "live") == 0  # dry run only prints the plan
    assert "STOP: never pay" in capsys.readouterr().out


@pytest.mark.parametrize("mode", [None, "", "live", "LIVE", " live", "Test", "sk_live_x"])
def test_live_journey_fails_closed_unless_uat_serves_exactly_stripe_test_mode(
    monkeypatch, capsys, mode
):
    # Unset, secret-referenced (read as None), live in any spelling, or anything
    # that is not exactly "test" refuses before any request is made.
    monkeypatch.setenv("DRIVE_PACKET_EVAL_LIVE", "1")
    assert journey_module.main(["--live"], stripe_mode=lambda: mode) == 2
    assert "not_stripe_test_mode" in capsys.readouterr().out


def test_live_journey_needs_the_live_flag_before_reading_uat(monkeypatch, capsys):
    monkeypatch.delenv("DRIVE_PACKET_EVAL_LIVE", raising=False)

    def never():
        raise AssertionError("UAT was read without the live opt-in")

    assert journey_module.main(["--live"], stripe_mode=never) == 2
    assert "DRIVE_PACKET_EVAL_LIVE" in capsys.readouterr().out


def test_live_journey_opens_no_uat_transport_even_in_stripe_test_mode(monkeypatch):
    monkeypatch.setenv("DRIVE_PACKET_EVAL_LIVE", "1")

    def no_transport(*_args, **_kwargs):
        raise AssertionError("a UAT transport was opened")

    monkeypatch.setattr(journey_module, "ApiTransport", no_transport)
    with pytest.raises(SystemExit, match="designated test-account sessions"):
        journey_module.main(["--live"], stripe_mode=lambda: "test")


def test_uat_stripe_mode_reads_only_a_literal_served_value():
    def service(env):
        described = {"spec": {"template": {"spec": {"containers": [{"env": env}]}}}}
        return lambda *_args: json.dumps(described)

    assert journey_module.uat_stripe_mode(service([{"name": "STRIPE_MODE", "value": "live"}])) == (
        "live"
    )
    secret = [{"name": "STRIPE_MODE", "valueFrom": {"secretKeyRef": {"name": "x"}}}]
    assert journey_module.uat_stripe_mode(service(secret)) is None
    assert journey_module.uat_stripe_mode(service([])) is None
