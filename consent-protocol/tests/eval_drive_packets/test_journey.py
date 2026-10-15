"""Buyer journey replay at the API level: ask, review, deny, allow, terms, checkout
once, stop before paying, cancel, no grant, one request per listed packet."""

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
