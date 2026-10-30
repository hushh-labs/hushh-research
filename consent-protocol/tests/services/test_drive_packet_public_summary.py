"""Public count projection keeps discovery separate from frozen sale authority."""

from datetime import UTC, date, datetime

import pytest

from hushh_mcp.services.drive_packet_public_summary import _project

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


@pytest.fixture
def summary_row():
    return {
        "packet_id": "00000000-0000-0000-0000-000000000001",
        "user_id": "owner",
        "current_version": 1,
        "state": "ready",
        "available": True,
        "listing_enabled": True,
        "buyer_status": None,
        "period_start": date(2026, 5, 1),
        "period_end": date(2026, 6, 30),
        "period_timezone": "UTC",
        "document_count": 25,
        "version_updated_at": datetime(2026, 7, 1, tzinfo=UTC),
        "preview_document_count": 51,
        "preview_complete": True,
        "preview_updated_at": datetime(2026, 7, 2, tzinfo=UTC),
    }


def project(row, *, relationship="connected", purchases=True, processing_ready=True):
    return _project(row, "viewer", purchases, relationship, processing_ready)


@pytest.mark.parametrize("sale_count", [0, 25])
def test_new_discovery_does_not_inherit_older_sale_count_or_purchase_authority(
    summary_row, sale_count
):
    row = {
        **summary_row,
        "document_count": sale_count,
        "state": "ready" if sale_count else "incomplete",
        "available": bool(sale_count),
    }
    result = project(row)
    assert result["documentCount"] == 51
    assert result["countBasis"] == "discovery_matches"
    assert result["saleDocumentCount"] == sale_count
    assert result["complete"] is True
    assert result["updatedAt"] == row["preview_updated_at"].isoformat()
    assert result["version"] == 1
    assert result["availability"] == ("ready" if sale_count else "unavailable")
    assert result["viewerAction"] == ("request" if sale_count else "unavailable")
    assert result["priceCents"] == 500 and result["currency"] == "USD"


@pytest.mark.parametrize(
    ("matched", "complete", "expected"),
    [(None, False, None), (0, False, None), (0, True, 0), (7, False, 7)],
)
def test_unknown_and_partial_discovery_are_not_reported_as_completed_empty_sale(
    summary_row, matched, complete, expected
):
    row = {
        **summary_row,
        "document_count": 0,
        "state": "incomplete",
        "available": False,
        "preview_document_count": matched,
        "preview_complete": complete,
    }
    result = project(row)
    assert result["documentCount"] == expected
    assert result["countBasis"] == "discovery_matches"
    assert result["complete"] is complete
    assert result["saleDocumentCount"] == 0
    assert result["availability"] == "unavailable"
    assert result["viewerAction"] == "unavailable"


def test_frozen_fallback_preserves_exact_membership_without_a_saved_search(summary_row):
    row = {
        **summary_row,
        "preview_document_count": None,
        "preview_complete": False,
        "preview_updated_at": None,
    }
    result = project(row)
    assert result["documentCount"] == result["saleDocumentCount"] == 25
    assert result["countBasis"] == "sale_files" and result["complete"]
    assert result["updatedAt"] == row["version_updated_at"].isoformat()


def test_unfrozen_unknown_and_completed_empty_have_no_sale_membership(summary_row):
    row = {
        **summary_row,
        "current_version": 0,
        "document_count": None,
        "preview_document_count": None,
        "preview_complete": False,
        "preview_updated_at": None,
        "version_updated_at": None,
    }
    result = project(row)
    assert result["documentCount"] is None and result["saleDocumentCount"] is None
    assert result["countBasis"] == "discovery_matches" and not result["complete"]
    assert result["availability"] == "preparing" and result["viewerAction"] == "unavailable"
    result = project({**row, "preview_document_count": 0, "preview_complete": True})
    assert result["documentCount"] == 0 and result["complete"]
    assert result["saleDocumentCount"] is None


@pytest.mark.parametrize(
    ("patch", "options"),
    [
        ({"state": "incomplete"}, {}),
        ({"available": False}, {}),
        ({"listing_enabled": False}, {}),
        ({}, {"purchases": False}),
        ({}, {"processing_ready": False}),
    ],
)
def test_discovery_count_does_not_bypass_any_existing_purchase_gate(summary_row, patch, options):
    result = project({**summary_row, **patch}, **options)
    assert result["documentCount"] == 51 and result["saleDocumentCount"] == 25
    assert result["availability"] == "unavailable"
    assert result["viewerAction"] == "unavailable"


@pytest.mark.parametrize(
    ("relationship", "status", "expected"),
    [
        ("none", "completed", "connect"),
        ("pending_outgoing", "completed", "pending"),
        ("pending_incoming", "completed", "unavailable"),
        ("connected", "pending", "view_request"),
        ("connected", "completed", "view_files"),
        ("connected", "partial", "view_files"),
    ],
)
def test_discovery_projection_keeps_relationship_and_existing_request_authority(
    summary_row, relationship, status, expected
):
    result = project({**summary_row, "buyer_status": status}, relationship=relationship)
    assert result["viewerAction"] == expected
    assert result["version"] == 1 and result["saleDocumentCount"] == 25


@pytest.mark.parametrize(
    ("version", "sale", "matched", "complete", "expected"),
    [(1, 0, 51, True, 51), (1, 25, 51, True, 51), (1, 25, 0, False, None), (0, None, 0, True, 0)],
)
def test_catalog_and_public_counts_agree_without_changing_frozen_request_authority(
    summary_row, monkeypatch, version, sale, matched, complete, expected
):
    from types import SimpleNamespace

    from hushh_mcp.services.drive_period_packet_reader import project_packet

    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "true")
    row = {
        **summary_row,
        "current_version": version,
        "version": version,
        "document_count": sale,
        "available": bool(sale),
        "preview_document_count": matched,
        "preview_complete": complete,
        "category": "financial",
        "error_code": None,
        "listing_revision": 1,
    }
    store = SimpleNamespace(
        _manifest=lambda _: {"state": "ready" if sale else "empty"},
        _key=lambda _: {"title": "Financial documents"},
    )
    catalog = project_packet(store, row, is_owner=False, owner_contents=False)
    summary = project(row)
    assert catalog["documentCount"] == summary["documentCount"] == expected
    assert catalog["saleDocumentCount"] == summary["saleDocumentCount"] == sale
    assert catalog["version"] == summary["version"] == version
    assert catalog["canRequest"] is bool(sale)
    assert catalog["listingEnabled"] is True
    assert catalog["purchaseState"] == "none"


def test_empty_sale_query_allows_only_authored_aliases_and_binds_runtime_values():
    from types import SimpleNamespace

    from hushh_mcp.services.drive_period_packet_freeze import (
        empty_sale_recovery_predicate,
        recoverable_empty_sale,
    )

    for alias in ("h", "drive_packet_heads"):
        assert f"{alias}.current_version" in empty_sale_recovery_predicate(alias)
    with pytest.raises(ValueError, match="invalid_packet_head_alias"):
        empty_sale_recovery_predicate("h; SELECT private_information")
    observed = []
    connection = SimpleNamespace(
        execute=lambda statement, parameters: (
            observed.append((str(statement), parameters))
            or SimpleNamespace(scalar_one=lambda: False)
        )
    )
    opaque_packet = "opaque-packet' OR TRUE --"
    assert not recoverable_empty_sale(None, connection, {"packet_id": opaque_packet})
    statement, parameters = observed[0]
    assert opaque_packet not in statement
    assert ":packet" in statement and ":template" in statement
    assert parameters["packet"] == opaque_packet
    assert parameters["template"] not in statement
