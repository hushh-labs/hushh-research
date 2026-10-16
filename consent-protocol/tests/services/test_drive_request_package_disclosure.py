"""Buyer coverage is selected-only, deterministic, and bound to sealed Allow."""

from copy import deepcopy

import pytest

from hushh_mcp.services.drive_request_package_disclosure import (
    build_package_disclosure,
    buyer_package_disclosure,
    manual_buyer_disclosure,
)
from hushh_mcp.services.drive_request_requester_store import requester_price_view


def observation(position, start, end, *, source_ref="p1"):
    return {
        "position": position,
        "assessment": {
            "decision": "include",
            "citations": [{"source_ref": source_ref, "quote": "Private source content"}],
            "covered_periods": [
                {"period_start": start, "period_end": end, "source_refs": [source_ref]}
            ],
        },
    }


def disclosure():
    return build_package_disclosure(
        package={
            "selected_positions": [1, 3],
            "digest": "a" * 64,
            "revision": 2,
            "assessment": {"coverage_status": "partial", "gaps": ["Private filename and account"]},
        },
        purpose={"periodStart": "2026-01-01", "periodEnd": "2026-03-31"},
        observations=[
            observation(1, "2026-01-01", "2026-01-31"),
            observation(2, "2026-02-01", "2026-02-28"),
            observation(3, "2026-03-01", "2026-03-31"),
        ],
    )


def test_selected_evidence_only_discloses_exact_missing_interval():
    value = disclosure()
    assert value["periods"] == [
        {"start": "2026-01-01", "end": "2026-01-31"},
        {"start": "2026-03-01", "end": "2026-03-31"},
    ]
    assert value["limitations"] == [
        "This package covers only part of your request.",
        "Selected documents do not verify coverage from 2026-02-01 to 2026-02-28.",
    ]
    assert "Private" not in str(value)


def test_no_verified_period_uses_unknown_without_file_timestamp_guess():
    value = build_package_disclosure(
        package={
            "selected_positions": [1],
            "digest": "a" * 64,
            "revision": 1,
            "assessment": {"coverage_status": "complete"},
        },
        purpose={"periodStart": "2026-01-01", "periodEnd": "2026-03-31"},
        observations=[
            {
                "position": 1,
                "assessment": {"decision": "include", "citations": [], "covered_periods": []},
            }
        ],
    )
    assert value["coverageStatus"] == "unknown"
    assert value["periods"] == [] and value["limitations"]


def private_allowed():
    value = disclosure()
    sources = [
        {
            "position": p,
            "source_version": "1",
            "file_digest": "b" * 64,
            "content_fingerprint": "c" * 64,
            "evidence_digest": "d" * 64,
        }
        for p in [1, 3]
    ]
    return {
        "agent_package_required": True,
        "trusted_auto": True,
        "owner_allowed": {
            "v": 1,
            "amount_cents": 125,
            "package_revision": 2,
            "package_digest": "a" * 64,
            "request_revision": 4,
            "connection_generation": 1,
            "search_job_id": "synthetic",
            "selected_positions": [1, 3],
            "selected_sources": sources,
            "package_selected_count": 2,
            "buyer_disclosure": value,
        },
    }


@pytest.mark.parametrize("change", ["no_allow", "revision", "digest", "package_revision", "count"])
def test_disclosure_rejects_missing_or_mismatched_approval(change):
    private = deepcopy(private_allowed())
    at, revision = "2026-10-13", 4
    if change == "no_allow":
        at = None
    elif change == "revision":
        revision = 5
    else:
        field = {
            "digest": "packageDigest",
            "package_revision": "packageRevision",
            "count": "selectedCount",
        }[change]
        private["owner_allowed"]["buyer_disclosure"][field] = "f" * 64 if change == "digest" else 3
    assert buyer_package_disclosure(private, request_revision=revision, owner_allowed_at=at) is None


def test_current_sealed_disclosure_projects_exactly():
    assert (
        buyer_package_disclosure(
            private_allowed(), request_revision=4, owner_allowed_at="2026-10-13"
        )
        == disclosure()
    )


def test_trusted_selection_has_buyer_coverage_without_claiming_owner_allow():
    private = private_allowed()
    private["v1_live_request"] = True
    private["trusted_selection"] = private.pop("owner_allowed")
    private["trusted_selection"]["selected_at"] = "2026-10-16T00:00:00Z"
    assert (
        buyer_package_disclosure(private, request_revision=4, owner_allowed_at=None) == disclosure()
    )
    private["v1_live_request"] = False
    assert buyer_package_disclosure(private, request_revision=4, owner_allowed_at=None) is None


def _manual_private(approved_positions):
    marker = deepcopy(private_allowed()["owner_allowed"])
    marker.update(
        {
            "selected_at": "2026-10-16T00:00:00Z",
            "approved_share_id": "f226a8fb-2ee1-4efa-91ac-6ab565c0477e",
            "approved_positions": approved_positions,
        }
    )
    return {
        "v1_live_request": True,
        "agent_package_required": False,
        "trusted_auto": False,
        "reusable_packet": None,
        "owner_allowed": None,
        "v1_manual_review": marker,
    }


def test_manual_buyer_disclosure_reuses_full_selection_coverage():
    assert manual_buyer_disclosure(_manual_private([1, 3]), request_revision=4) == disclosure()


def test_manual_buyer_disclosure_binds_subset_without_overclaiming_coverage():
    private = _manual_private([1])
    value = manual_buyer_disclosure(private, request_revision=4)
    assert value["selectedCount"] == 1
    assert value["coverageStatus"] == "unknown"
    assert value["periods"] == [] and value["limitations"]
    assert value["packageDigest"] != disclosure()["packageDigest"]
    private["v1_manual_review"]["approved_share_id"] = "fa4d3e62-9dc5-4070-bd40-32c85a51a2c4"
    assert (
        manual_buyer_disclosure(private, request_revision=4)["packageDigest"]
        != value["packageDigest"]
    )
    assert manual_buyer_disclosure(private, request_revision=5) is None
    private["v1_manual_review"]["buyer_disclosure"]["selectedCount"] = 3
    assert manual_buyer_disclosure(private, request_revision=4) is None


@pytest.mark.parametrize("amount", [50, 125, 50000])
def test_requester_price_view_preserves_supported_cent_prices(amount):
    result = requester_price_view(
        initial_quote_cents=amount,
        quoted_amount_cents=amount,
        owner_allowed=True,
        order_amount_cents=amount,
    )
    assert result == {
        "estimateCents": amount,
        "currentCents": amount,
        "finalCents": amount,
        "state": "final",
    }


def test_payment_disclosure_hint_preserves_existing_settlement_states():
    from datetime import UTC, datetime, timedelta

    from hushh_mcp.services.drive_request_payment_view import requester_payment_view

    now = datetime.now(UTC)
    view = requester_payment_view(
        payment_required=True,
        request_status="pending",
        request_expires_at=now + timedelta(days=1),
        now=now,
        order={"status": "paid", "amount_cents": 125},
        package_disclosure_required=True,
    )
    assert view["packageDisclosureRequired"] is True
    assert "packageDisclosure" not in view
    assert view["state"] == "paid" and view["nextAction"] == "none"


def test_disclosure_overflow_never_claims_complete_coverage():
    from datetime import date, timedelta

    items = []
    for position in range(1, 17):
        item = observation(position, "2026-01-01", "2026-01-01")
        item["assessment"]["covered_periods"] = []
        for index in range(8):
            day = (date(2026, 1, 1) + timedelta(days=2 * (8 * (position - 1) + index))).isoformat()
            item["assessment"]["covered_periods"].append(
                {"period_start": day, "period_end": day, "source_refs": ["p1"]}
            )
        items.append(item)
    value = build_package_disclosure(
        package={
            "selected_positions": list(range(1, 17)),
            "digest": "a" * 64,
            "revision": 1,
            "assessment": {"coverage_status": "complete"},
        },
        purpose={},
        observations=items,
    )
    assert value["coverageStatus"] == "unknown" and value["periods"] == []
    assert value["limitations"] == [
        "The verified coverage contains too many separate date intervals to display here."
    ]
