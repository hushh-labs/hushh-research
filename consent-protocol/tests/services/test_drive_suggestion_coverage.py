"""A claimed complete period requires cited, gap-free observed dates."""

from hushh_mcp.services.drive_suggestion_service import CoveredPeriod, period_covered


def period(start, end, ref="source-1"):
    return CoveredPeriod(period_start=start, period_end=end, source_refs=[ref])


def test_full_six_completed_months_need_cited_contiguous_coverage():
    purpose = {"periodStart": "2026-03-01", "periodEnd": "2026-08-31"}
    known = {"source-1": {"document_ref": "document-1"}}
    assert period_covered(
        purpose,
        [period("2026-03-01", "2026-05-31"), period("2026-06-01", "2026-08-31")],
        known,
        ["document-1"],
    )
    assert not period_covered(
        purpose,
        [period("2026-03-01", "2026-05-31"), period("2026-07-01", "2026-08-31")],
        known,
        ["document-1"],
    )
    assert not period_covered(
        purpose,
        [period("2026-03-01", "2026-08-31", "invented")],
        known,
        ["document-1"],
    )
