from __future__ import annotations

import asyncio
import io
import zipfile
from datetime import date

from hushh_mcp.services.marketplace_investor_replenisher import (
    InvestorCandidate,
    MarketplaceInvestorReplenisher,
    SecEdgarClient,
    candidate_from_sec_submission,
    candidates_from_13f_dataset_archive,
)


def _submission_payload(cik: str = "1166559") -> dict:
    return {
        "cik": cik,
        "name": "GATES FOUNDATION TRUST",
        "addresses": {
            "business": {
                "street1": "2365 CARILLON POINT",
                "city": "KIRKLAND",
                "stateOrCountry": "WA",
                "zipCode": "98033",
            }
        },
        "filings": {
            "recent": {
                "form": ["13F-HR", "4"],
                "filingDate": ["2026-05-15", "2026-04-11"],
                "accessionNumber": ["0001104659-26-062592", "0001166559-26-000001"],
            }
        },
    }


def test_candidate_from_sec_submission_requires_official_filing_evidence():
    candidate = candidate_from_sec_submission(_submission_payload(), curated=True)

    assert candidate is not None
    assert candidate.cik == "0001166559"
    assert candidate.name == "GATES FOUNDATION TRUST"
    assert candidate.location_hint == "Kirkland, WA 98033"
    assert candidate.last_13f_date == date(2026, 5, 15)
    assert candidate.curation_tier == "showcase"
    assert candidate.quality_score >= 90
    assert "https://data.sec.gov/submissions/CIK0001166559.json" in candidate.source_urls


def test_replenisher_suppresses_weak_candidate_without_evidence():
    replenisher = MarketplaceInvestorReplenisher(
        target_total=100,
        target_showcase=50,
        enable_13f_dataset_expansion=False,
    )
    weak = InvestorCandidate(
        name="Weak Row",
        cik="0000000001",
        firm="Weak Row",
        biography="too short",
        source_urls=[],
        last_13f_date=None,
        quality_score=95,
    )

    assert replenisher.validate_candidate(weak) == (False, "missing_source_urls")


class _FakeUpsertConn:
    def __init__(self, inserted: bool) -> None:
        self.inserted = inserted
        self.fetchrow_calls: list[tuple[str, tuple[object, ...]]] = []

    async def fetchrow(self, query: str, *args: object) -> dict:
        self.fetchrow_calls.append((query, args))
        assert "ON CONFLICT (cik) DO UPDATE" in query
        assert args[2] == "0001166559"
        assert args[15] == "showcase"
        return {"inserted": self.inserted}


def test_replenisher_upsert_is_idempotent_by_cik():
    async def _run() -> None:
        candidate = candidate_from_sec_submission(_submission_payload(), curated=True)
        assert candidate is not None
        replenisher = MarketplaceInvestorReplenisher(enable_13f_dataset_expansion=False)

        inserted = await replenisher.upsert_candidate(_FakeUpsertConn(True), candidate)  # type: ignore[arg-type]
        updated = await replenisher.upsert_candidate(_FakeUpsertConn(False), candidate)  # type: ignore[arg-type]

        assert inserted is True
        assert updated is False

    asyncio.run(_run())


def test_sec_client_declares_user_agent_and_stays_below_sec_rate_boundary():
    client = SecEdgarClient(
        user_agent="Hushh Test contact: test@hushh.ai", rate_limit_per_second=99
    )

    assert client.headers["User-Agent"] == "Hushh Test contact: test@hushh.ai"
    assert client.rate_limit_per_second < 10


def test_13f_dataset_archive_produces_public_sec_candidates():
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr(
            "SUBMISSION.tsv",
            "ACCESSION_NUMBER\tCIK\tSUBMISSIONTYPE\tFILING_DATE\n"
            "0000000001-26-000001\t1\t13F-HR\t31-DEC-2025\n",
        )
        zf.writestr(
            "COVERPAGE.tsv",
            "ACCESSION_NUMBER\tFILINGMANAGER_NAME\tFILINGMANAGER_STREET1\tFILINGMANAGER_CITY\tFILINGMANAGER_STATEORCOUNTRY\tFILINGMANAGER_ZIPCODE\n"
            "0000000001-26-000001\tExample Capital Management\t100 Main St\tKirkland\tWA\t98033\n",
        )

    candidates = candidates_from_13f_dataset_archive(
        archive.getvalue(),
        dataset_url="https://www.sec.gov/files/structureddata/data/form-13f-data-sets/example_form13f.zip",
        max_candidates=5,
        showcase_slots=1,
    )

    assert len(candidates) == 1
    assert candidates[0].cik == "0000000001"
    assert candidates[0].curation_tier == "showcase"
    assert candidates[0].last_13f_date == date(2025, 12, 31)
    assert candidates[0].location_hint == "Kirkland, WA 98033"
    assert candidates[0].business_address["street1"] == "100 Main St"
    assert candidates[0].source_urls[0].endswith("example_form13f.zip")
