from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import os
import re
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any
from urllib.parse import urljoin

import asyncpg
import httpx

from db.connection import get_pool

logger = logging.getLogger(__name__)

SEC_DATA_BASE_URL = "https://data.sec.gov"
SEC_SITE_BASE_URL = "https://www.sec.gov"
SEC_13F_DATASETS_PAGE = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets"
DEFAULT_SEC_USER_AGENT = "Hushh RIA Marketplace Investor Replenisher contact: engineering@hushh.ai"
RELEVANT_SEC_FORMS = {
    "13F-HR",
    "13F-HR/A",
    "13F-NT",
    "13F-NT/A",
    "3",
    "3/A",
    "4",
    "4/A",
    "5",
    "5/A",
    "SC 13D",
    "SC 13D/A",
    "SC 13G",
    "SC 13G/A",
}
QUALIFYING_13F_FORMS = {"13F-HR", "13F-HR/A"}
HANDLED_DECK_STATUSES = ("passed", "shortlisted", "connect_requested")
CURATED_DEFAULT_CIKS: tuple[str, ...] = (
    "0001166559",
    "0001067983",
    "0001350694",
    "0001336528",
    "0001423053",
    "0001273087",
    "0001603466",
    "0001037389",
    "0001167483",
    "0001647251",
    "0001536411",
    "0001081019",
    "0001535630",
    "0001352851",
    "0001656456",
    "0001541617",
    "0001510281",
    "0001214717",
    "0001595082",
    "0001061768",
    "0000315066",
    "0000902219",
    "0001649339",
    "0001697748",
)


@dataclass(slots=True)
class InvestorCandidate:
    name: str
    cik: str
    firm: str
    title: str = "Public institutional filer"
    investor_type: str = "institutional_investor"
    location_hint: str | None = None
    business_address: dict[str, Any] = field(default_factory=dict)
    investment_style: list[str] = field(default_factory=lambda: ["public_13f"])
    biography: str | None = None
    data_sources: list[str] = field(default_factory=list)
    source_urls: list[str] = field(default_factory=list)
    evidence: dict[str, Any] = field(default_factory=dict)
    last_13f_date: date | None = None
    last_form4_date: date | None = None
    marketplace_eligible: bool = True
    curation_tier: str = "qualified"
    admission_status: str = "qualified"
    quality_score: int = 85
    curation_reason: str = "Qualified official SEC-backed public investor profile."


@dataclass(slots=True)
class ReplenisherResult:
    run_id: str
    status: str
    target_total: int
    target_showcase: int
    existing_eligible_count: int
    existing_showcase_count: int
    final_eligible_count: int
    final_showcase_count: int
    candidate_count: int
    inserted_count: int
    updated_count: int
    suppressed_count: int
    error_count: int
    source_errors: list[dict[str, Any]]
    duration_ms: int

    def to_log_payload(self) -> dict[str, Any]:
        return {
            "event": "marketplace_investor_replenisher_run",
            "run_id": self.run_id,
            "status": self.status,
            "target_total": self.target_total,
            "target_showcase": self.target_showcase,
            "existing_eligible_count": self.existing_eligible_count,
            "existing_showcase_count": self.existing_showcase_count,
            "final_eligible_count": self.final_eligible_count,
            "final_showcase_count": self.final_showcase_count,
            "candidate_count": self.candidate_count,
            "inserted_count": self.inserted_count,
            "updated_count": self.updated_count,
            "suppressed_count": self.suppressed_count,
            "error_count": self.error_count,
            "source_errors": self.source_errors,
            "duration_ms": self.duration_ms,
        }


class SecEdgarClient:
    """Small EDGAR client with declared User-Agent and bounded request rate."""

    def __init__(
        self,
        *,
        user_agent: str | None = None,
        rate_limit_per_second: float = 5.0,
        timeout_seconds: float = 30.0,
    ) -> None:
        self.user_agent = (user_agent or DEFAULT_SEC_USER_AGENT).strip()
        self.rate_limit_per_second = max(0.25, min(float(rate_limit_per_second), 9.0))
        self.timeout_seconds = timeout_seconds
        self._client: httpx.AsyncClient | None = None
        self._last_request_at = 0.0

    @property
    def headers(self) -> dict[str, str]:
        return {
            "User-Agent": self.user_agent,
            "Accept": "application/json,text/html,application/zip,*/*",
        }

    async def __aenter__(self) -> "SecEdgarClient":
        self._client = httpx.AsyncClient(
            headers=self.headers,
            follow_redirects=True,
            timeout=self.timeout_seconds,
        )
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        if self._client:
            await self._client.aclose()
        self._client = None

    async def _rate_limit(self) -> None:
        min_interval = 1.0 / self.rate_limit_per_second
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < min_interval:
            await asyncio.sleep(min_interval - elapsed)
        self._last_request_at = time.monotonic()

    async def get_json(self, url: str) -> dict[str, Any]:
        await self._rate_limit()
        client = self._client or httpx.AsyncClient(
            headers=self.headers,
            follow_redirects=True,
            timeout=self.timeout_seconds,
        )
        close_client = self._client is None
        try:
            response = await client.get(url)
            response.raise_for_status()
            payload = response.json()
            return payload if isinstance(payload, dict) else {}
        finally:
            if close_client:
                await client.aclose()

    async def get_text(self, url: str) -> str:
        await self._rate_limit()
        client = self._client or httpx.AsyncClient(
            headers=self.headers,
            follow_redirects=True,
            timeout=self.timeout_seconds,
        )
        close_client = self._client is None
        try:
            response = await client.get(url)
            response.raise_for_status()
            return response.text
        finally:
            if close_client:
                await client.aclose()

    async def get_bytes(self, url: str) -> bytes:
        await self._rate_limit()
        client = self._client or httpx.AsyncClient(
            headers=self.headers,
            follow_redirects=True,
            timeout=max(self.timeout_seconds, 120.0),
        )
        close_client = self._client is None
        try:
            response = await client.get(url)
            response.raise_for_status()
            return response.content
        finally:
            if close_client:
                await client.aclose()


class MarketplaceInvestorReplenisher:
    def __init__(
        self,
        *,
        sec_client: SecEdgarClient | None = None,
        target_total: int | None = None,
        target_showcase: int | None = None,
        min_quality_score: int = 80,
        enable_13f_dataset_expansion: bool | None = None,
    ) -> None:
        self.sec_client = sec_client or SecEdgarClient(
            user_agent=os.getenv("SEC_EDGAR_USER_AGENT"),
            rate_limit_per_second=_float_env("MARKETPLACE_INVESTOR_RATE_LIMIT_PER_SECOND", 5.0),
        )
        self.target_total = (
            target_total
            if target_total is not None
            else _int_env(
                "MARKETPLACE_INVESTOR_TARGET_TOTAL",
                100,
            )
        )
        self.target_showcase = (
            target_showcase
            if target_showcase is not None
            else _int_env("MARKETPLACE_INVESTOR_TARGET_SHOWCASE", 50)
        )
        self.min_quality_score = min_quality_score
        self.enable_13f_dataset_expansion = (
            enable_13f_dataset_expansion
            if enable_13f_dataset_expansion is not None
            else str(os.getenv("MARKETPLACE_INVESTOR_ENABLE_13F_DATASET", "1")).strip()
            not in {"0", "false", "False"}
        )

    async def run(self) -> ReplenisherResult:
        started_at = time.monotonic()
        run_id = f"marketplace-investor-replenisher-{uuid.uuid4()}"
        source_errors: list[dict[str, Any]] = []
        inserted_count = 0
        updated_count = 0
        suppressed_count = 0
        candidate_count = 0
        pool = await get_pool()
        async with pool.acquire() as conn:
            existing = await self._count_inventory(conn)
            await self._insert_audit_start(
                conn,
                run_id=run_id,
                existing_counts=existing,
            )
            try:
                async with self.sec_client:
                    candidates, source_errors = await self.collect_candidates(
                        existing_eligible_count=existing["eligible_count"],
                        existing_showcase_count=existing["showcase_count"],
                    )
                candidate_count = len(candidates)
                seen_ciks: set[str] = set()
                for candidate in candidates:
                    if candidate.cik in seen_ciks:
                        continue
                    seen_ciks.add(candidate.cik)
                    valid, reason = self.validate_candidate(candidate)
                    if not valid:
                        suppressed_count += 1
                        source_errors.append(
                            {
                                "source": "candidate_validation",
                                "cik": candidate.cik,
                                "reason": reason,
                            }
                        )
                        continue
                    inserted = await self.upsert_candidate(conn, candidate)
                    if inserted:
                        inserted_count += 1
                    else:
                        updated_count += 1

                final_counts = await self._count_inventory(conn)
                duration_ms = int((time.monotonic() - started_at) * 1000)
                result = ReplenisherResult(
                    run_id=run_id,
                    status="succeeded",
                    target_total=self.target_total,
                    target_showcase=self.target_showcase,
                    existing_eligible_count=existing["eligible_count"],
                    existing_showcase_count=existing["showcase_count"],
                    final_eligible_count=final_counts["eligible_count"],
                    final_showcase_count=final_counts["showcase_count"],
                    candidate_count=candidate_count,
                    inserted_count=inserted_count,
                    updated_count=updated_count,
                    suppressed_count=suppressed_count,
                    error_count=len(source_errors),
                    source_errors=source_errors,
                    duration_ms=duration_ms,
                )
                await self._finish_audit(conn, result)
                return result
            except Exception as exc:
                final_counts = await self._count_inventory(conn)
                duration_ms = int((time.monotonic() - started_at) * 1000)
                source_errors.append(
                    {
                        "source": "replenisher",
                        "reason": type(exc).__name__,
                        "message": str(exc)[:500],
                    }
                )
                result = ReplenisherResult(
                    run_id=run_id,
                    status="failed",
                    target_total=self.target_total,
                    target_showcase=self.target_showcase,
                    existing_eligible_count=existing["eligible_count"],
                    existing_showcase_count=existing["showcase_count"],
                    final_eligible_count=final_counts["eligible_count"],
                    final_showcase_count=final_counts["showcase_count"],
                    candidate_count=candidate_count,
                    inserted_count=inserted_count,
                    updated_count=updated_count,
                    suppressed_count=suppressed_count,
                    error_count=len(source_errors),
                    source_errors=source_errors,
                    duration_ms=duration_ms,
                )
                await self._finish_audit(conn, result)
                raise

    async def collect_candidates(
        self,
        *,
        existing_eligible_count: int,
        existing_showcase_count: int,
    ) -> tuple[list[InvestorCandidate], list[dict[str, Any]]]:
        candidates: list[InvestorCandidate] = []
        source_errors: list[dict[str, Any]] = []
        cik_list = _configured_ciks()
        for cik in cik_list:
            try:
                payload = await self.sec_client.get_json(_submissions_url(cik))
                candidate = candidate_from_sec_submission(payload, curated=True)
                if candidate:
                    candidates.append(candidate)
            except Exception as exc:
                source_errors.append(
                    {
                        "source": "sec_submissions",
                        "cik": cik,
                        "reason": type(exc).__name__,
                        "message": str(exc)[:300],
                    }
                )

        target_gap = max(0, self.target_total - existing_eligible_count - len(candidates))
        showcase_gap = max(
            0,
            self.target_showcase
            - existing_showcase_count
            - sum(1 for item in candidates if item.curation_tier == "showcase"),
        )
        if self.enable_13f_dataset_expansion and (target_gap > 0 or showcase_gap > 0):
            try:
                dataset_candidates = await self.fetch_latest_13f_dataset_candidates(
                    max_candidates=max(target_gap, showcase_gap, 0) + 25,
                    showcase_slots=showcase_gap,
                )
                candidates.extend(dataset_candidates)
            except Exception as exc:
                source_errors.append(
                    {
                        "source": "sec_13f_dataset",
                        "reason": type(exc).__name__,
                        "message": str(exc)[:500],
                    }
                )
        return candidates, source_errors

    async def fetch_latest_13f_dataset_candidates(
        self,
        *,
        max_candidates: int,
        showcase_slots: int,
    ) -> list[InvestorCandidate]:
        page = await self.sec_client.get_text(SEC_13F_DATASETS_PAGE)
        match = re.search(r'href="([^"]+_form13f\.zip)"', page, flags=re.IGNORECASE)
        if not match:
            return []
        dataset_url = urljoin(SEC_SITE_BASE_URL, match.group(1))
        archive = await self.sec_client.get_bytes(dataset_url)
        return candidates_from_13f_dataset_archive(
            archive,
            dataset_url=dataset_url,
            max_candidates=max_candidates,
            showcase_slots=showcase_slots,
        )

    def validate_candidate(self, candidate: InvestorCandidate) -> tuple[bool, str | None]:
        if not candidate.cik or not candidate.cik.isdigit():
            return False, "missing_cik"
        if not candidate.name.strip():
            return False, "missing_name"
        if not candidate.source_urls:
            return False, "missing_source_urls"
        if not candidate.biography or len(candidate.biography.strip()) < 40:
            return False, "missing_public_profile_summary"
        if not (candidate.last_13f_date or candidate.last_form4_date):
            return False, "missing_recent_public_filing"
        if candidate.quality_score < self.min_quality_score:
            return False, "quality_below_threshold"
        if candidate.admission_status != "qualified":
            return False, "not_qualified"
        if candidate.curation_tier not in {"showcase", "qualified"}:
            return False, "not_deck_eligible"
        return True, None

    async def upsert_candidate(
        self, conn: asyncpg.Connection, candidate: InvestorCandidate
    ) -> bool:
        row = await conn.fetchrow(
            """
            INSERT INTO investor_profiles (
              name,
              name_normalized,
              cik,
              firm,
              title,
              investor_type,
              location_hint,
              business_address,
              investment_style,
              biography,
              data_sources,
              source_urls,
              evidence,
              last_13f_date,
              last_form4_date,
              marketplace_eligible,
              curation_tier,
              admission_status,
              quality_score,
              curation_reason,
              updated_at
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8::jsonb,
              $9::text[],
              $10,
              $11::text[],
              $12::text[],
              $13::jsonb,
              $14,
              $15,
              TRUE,
              $16,
              'qualified',
              $17,
              $18,
              NOW()
            )
            ON CONFLICT (cik) DO UPDATE SET
              name = EXCLUDED.name,
              name_normalized = EXCLUDED.name_normalized,
              firm = EXCLUDED.firm,
              title = EXCLUDED.title,
              investor_type = EXCLUDED.investor_type,
              location_hint = EXCLUDED.location_hint,
              business_address = EXCLUDED.business_address,
              investment_style = EXCLUDED.investment_style,
              biography = EXCLUDED.biography,
              data_sources = EXCLUDED.data_sources,
              source_urls = EXCLUDED.source_urls,
              evidence = EXCLUDED.evidence,
              last_13f_date = EXCLUDED.last_13f_date,
              last_form4_date = EXCLUDED.last_form4_date,
              marketplace_eligible = EXCLUDED.marketplace_eligible,
              curation_tier = EXCLUDED.curation_tier,
              admission_status = EXCLUDED.admission_status,
              quality_score = EXCLUDED.quality_score,
              curation_reason = EXCLUDED.curation_reason,
              updated_at = NOW()
            RETURNING (xmax = 0) AS inserted
            """,
            candidate.name,
            _normalize_name(candidate.name),
            candidate.cik,
            candidate.firm,
            candidate.title,
            candidate.investor_type,
            candidate.location_hint,
            json.dumps(candidate.business_address),
            candidate.investment_style,
            candidate.biography,
            candidate.data_sources,
            candidate.source_urls,
            json.dumps(candidate.evidence),
            candidate.last_13f_date,
            candidate.last_form4_date,
            candidate.curation_tier,
            candidate.quality_score,
            candidate.curation_reason,
        )
        return bool(row and dict(row).get("inserted"))

    async def _count_inventory(self, conn: asyncpg.Connection) -> dict[str, int]:
        row = await conn.fetchrow(
            """
            SELECT
              COUNT(*) FILTER (
                WHERE marketplace_eligible = TRUE
                  AND admission_status = 'qualified'
                  AND curation_tier IN ('showcase', 'qualified')
                  AND cik IS NOT NULL
                  AND array_length(source_urls, 1) IS NOT NULL
                  AND COALESCE(last_13f_date, last_form4_date) IS NOT NULL
              )::integer AS eligible_count,
              COUNT(*) FILTER (
                WHERE marketplace_eligible = TRUE
                  AND admission_status = 'qualified'
                  AND curation_tier = 'showcase'
                  AND cik IS NOT NULL
                  AND array_length(source_urls, 1) IS NOT NULL
                  AND COALESCE(last_13f_date, last_form4_date) IS NOT NULL
              )::integer AS showcase_count
            FROM investor_profiles
            """
        )
        payload = dict(row) if row else {}
        return {
            "eligible_count": int(payload.get("eligible_count") or 0),
            "showcase_count": int(payload.get("showcase_count") or 0),
        }

    async def _insert_audit_start(
        self,
        conn: asyncpg.Connection,
        *,
        run_id: str,
        existing_counts: dict[str, int],
    ) -> None:
        await conn.execute(
            """
            INSERT INTO marketplace_investor_replenisher_runs (
              run_id,
              status,
              target_total,
              target_showcase,
              metadata
            )
            VALUES ($1, 'started', $2, $3, $4::jsonb)
            """,
            run_id,
            self.target_total,
            self.target_showcase,
            json.dumps({"existing_counts": existing_counts}),
        )

    async def _finish_audit(
        self,
        conn: asyncpg.Connection,
        result: ReplenisherResult,
    ) -> None:
        await conn.execute(
            """
            UPDATE marketplace_investor_replenisher_runs
            SET
              status = $2,
              finished_at = NOW(),
              candidate_count = $3,
              inserted_count = $4,
              updated_count = $5,
              suppressed_count = $6,
              error_count = $7,
              source_errors = $8::jsonb,
              metadata = metadata || $9::jsonb
            WHERE run_id = $1
            """,
            result.run_id,
            result.status,
            result.candidate_count,
            result.inserted_count,
            result.updated_count,
            result.suppressed_count,
            result.error_count,
            json.dumps(result.source_errors),
            json.dumps(
                {
                    "final_eligible_count": result.final_eligible_count,
                    "final_showcase_count": result.final_showcase_count,
                    "duration_ms": result.duration_ms,
                }
            ),
        )


def candidate_from_sec_submission(
    payload: dict[str, Any],
    *,
    curated: bool = False,
) -> InvestorCandidate | None:
    cik = _normalize_cik(payload.get("cik") or payload.get("CIK"))
    name = _clean_text(payload.get("name") or payload.get("entityName"))
    if not cik or not name:
        return None

    latest_13f = _latest_submission(payload, QUALIFYING_13F_FORMS)
    latest_form4 = _latest_submission(payload, {"3", "3/A", "4", "4/A", "5", "5/A"})
    latest_relevant = latest_13f or latest_form4 or _latest_submission(payload, RELEVANT_SEC_FORMS)
    if not latest_relevant:
        return None

    business_address = _business_address(payload)
    location_hint = _location_hint(business_address)
    source_urls = [
        _submissions_url(cik),
        f"https://www.sec.gov/edgar/browse/?CIK={cik}",
    ]
    if latest_relevant.get("accession"):
        source_urls.append(_filing_url(cik, str(latest_relevant["accession"])))

    latest_form = str(latest_relevant.get("form") or "SEC filing")
    latest_date = latest_relevant.get("filing_date")
    curation_tier = "showcase" if curated else "qualified"
    quality_score = 88
    if latest_13f:
        quality_score += 5
    if business_address:
        quality_score += 3
    if curated:
        quality_score += 2
    quality_score = min(98, quality_score)
    style = ["public_13f"]
    if curated:
        style.append("curated_sec_filer")
    biography = (
        "Official SEC-backed investor discovery profile refreshed from EDGAR "
        f"submissions. Latest public evidence includes {latest_form}"
        f"{f' filed {latest_date.isoformat()}' if isinstance(latest_date, date) else ''}."
    )
    curation_reason = (
        "Showcase official SEC filer refreshed from submissions API."
        if curated
        else "Qualified official SEC filer refreshed from submissions API."
    )
    return InvestorCandidate(
        name=name,
        cik=cik,
        firm=name.title() if name.isupper() else name,
        location_hint=location_hint,
        business_address=business_address,
        investment_style=style,
        biography=biography,
        data_sources=["SEC EDGAR submissions API"],
        source_urls=list(dict.fromkeys(source_urls)),
        evidence={
            "confidence": "official_sec_record",
            "latest_form": latest_form,
            "latest_accession": latest_relevant.get("accession"),
            "curated": curated,
        },
        last_13f_date=latest_13f.get("filing_date") if latest_13f else None,
        last_form4_date=latest_form4.get("filing_date") if latest_form4 else None,
        curation_tier=curation_tier,
        quality_score=quality_score,
        curation_reason=curation_reason,
    )


def candidates_from_13f_dataset_archive(
    archive: bytes,
    *,
    dataset_url: str,
    max_candidates: int,
    showcase_slots: int,
) -> list[InvestorCandidate]:
    submissions: dict[str, dict[str, str]] = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        submission_name = _first_zip_member(zf, "SUBMISSION")
        cover_name = _first_zip_member(zf, "COVERPAGE")
        if not submission_name or not cover_name:
            return []
        with zf.open(submission_name) as raw:
            for row in csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig"), delimiter="\t"):
                accession = _field(row, "ACCESSION_NUMBER", "ACCESSIONNUMBER")
                cik = _normalize_cik(_field(row, "CIK", "FILER_CIK", "FILERCIK"))
                form = _clean_text(_field(row, "SUBMISSIONTYPE", "FORM_TYPE", "FORMTYPE"))
                if accession and cik and form in QUALIFYING_13F_FORMS:
                    submissions[accession] = row

        candidates: list[InvestorCandidate] = []
        seen_ciks: set[str] = set()
        with zf.open(cover_name) as raw:
            for row in csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig"), delimiter="\t"):
                accession = _field(row, "ACCESSION_NUMBER", "ACCESSIONNUMBER")
                submission = submissions.get(accession or "")
                if not submission:
                    continue
                cik = _normalize_cik(_field(submission, "CIK", "FILER_CIK", "FILERCIK"))
                if not cik or cik in seen_ciks or cik in CURATED_DEFAULT_CIKS:
                    continue
                name = _clean_text(
                    _field(
                        row,
                        "FILINGMANAGER_NAME",
                        "FILING_MANAGER_NAME",
                        "NAME",
                        "REPORTINGOWNER_NAME",
                    )
                )
                if not name:
                    continue
                filing_date = _parse_date(
                    _field(submission, "FILING_DATE", "FILINGDATE")
                    or _field(row, "REPORTCALENDARORQUARTER", "PERIODOFREPORT")
                )
                if not filing_date:
                    continue
                business_address = {
                    "street1": _clean_text(_field(row, "FILINGMANAGER_STREET1")),
                    "street2": _clean_text(_field(row, "FILINGMANAGER_STREET2")),
                    "city": _clean_text(_field(row, "FILINGMANAGER_CITY")),
                    "state": _clean_text(_field(row, "FILINGMANAGER_STATEORCOUNTRY")),
                    "zip": _clean_text(_field(row, "FILINGMANAGER_ZIPCODE")),
                    "source": "SEC Form 13F cover page",
                }
                business_address = {key: value for key, value in business_address.items() if value}
                accession_value = accession or ""
                curation_tier = "showcase" if len(candidates) < showcase_slots else "qualified"
                quality_score = 90 if curation_tier == "showcase" else 86
                if business_address:
                    quality_score += 3
                candidates.append(
                    InvestorCandidate(
                        name=name,
                        cik=cik,
                        firm=name.title() if name.isupper() else name,
                        location_hint=_location_hint(business_address) or "SEC 13F public filer",
                        business_address=business_address or {"source": "SEC Form 13F data set"},
                        investment_style=["public_13f", "institutional_filer"],
                        biography=(
                            "Official SEC-backed investor discovery profile derived from the "
                            "latest SEC Form 13F data set. The row is discovery-only and cites "
                            "public 13F filing evidence."
                        ),
                        data_sources=["SEC Form 13F data set"],
                        source_urls=[
                            dataset_url,
                            f"https://www.sec.gov/edgar/browse/?CIK={cik}",
                            _filing_url(cik, accession_value),
                        ],
                        evidence={
                            "confidence": "official_sec_13f_dataset",
                            "latest_known_13f_accession": accession_value,
                            "dataset_url": dataset_url,
                        },
                        last_13f_date=filing_date,
                        curation_tier=curation_tier,
                        quality_score=quality_score,
                        curation_reason=(
                            "Showcase institutional 13F filer from the latest official SEC data set."
                            if curation_tier == "showcase"
                            else "Qualified institutional 13F filer from the latest official SEC data set."
                        ),
                    )
                )
                seen_ciks.add(cik)
                if len(candidates) >= max_candidates:
                    return candidates
        return candidates


def _configured_ciks() -> tuple[str, ...]:
    raw = os.getenv("MARKETPLACE_INVESTOR_CIKS", "").strip()
    if not raw:
        return CURATED_DEFAULT_CIKS
    ciks = [_normalize_cik(item) for item in re.split(r"[\s,]+", raw) if item.strip()]
    return tuple(cik for cik in ciks if cik) or CURATED_DEFAULT_CIKS


def _latest_submission(
    payload: dict[str, Any],
    forms: set[str],
) -> dict[str, Any] | None:
    filings = payload.get("filings")
    recent = filings.get("recent") if isinstance(filings, dict) else None
    if not isinstance(recent, dict):
        return None
    form_values = recent.get("form") or []
    filing_dates = recent.get("filingDate") or []
    accession_values = recent.get("accessionNumber") or []
    best: dict[str, Any] | None = None
    for index, form in enumerate(form_values):
        form_value = str(form or "").strip().upper()
        if form_value not in forms:
            continue
        filing_date = _parse_date(_sequence_value(filing_dates, index))
        if not filing_date:
            continue
        accession = str(_sequence_value(accession_values, index) or "").strip()
        item = {"form": form_value, "filing_date": filing_date, "accession": accession}
        if best is None or filing_date > best["filing_date"]:
            best = item
    return best


def _business_address(payload: dict[str, Any]) -> dict[str, Any]:
    addresses = payload.get("addresses")
    business = addresses.get("business") if isinstance(addresses, dict) else None
    if not isinstance(business, dict):
        return {}
    address = {
        "street1": _clean_text(business.get("street1")),
        "street2": _clean_text(business.get("street2")),
        "city": _clean_text(business.get("city")),
        "state": _clean_text(business.get("stateOrCountry")),
        "zip": _clean_text(business.get("zipCode")),
        "source": "SEC submissions business address",
    }
    return {key: value for key, value in address.items() if value}


def _location_hint(address: dict[str, Any]) -> str | None:
    city = _clean_text(address.get("city"))
    state = _clean_text(address.get("state"))
    zip_code = _clean_text(address.get("zip"))
    if city and state and zip_code:
        return f"{city.title()}, {state} {zip_code}"
    if city and state:
        return f"{city.title()}, {state}"
    return None


def _submissions_url(cik: str) -> str:
    return f"{SEC_DATA_BASE_URL}/submissions/CIK{_normalize_cik(cik)}.json"


def _filing_url(cik: str, accession: str) -> str:
    cik_int = str(int(_normalize_cik(cik) or "0"))
    accession_safe = accession.strip()
    accession_path = accession_safe.replace("-", "")
    return f"{SEC_SITE_BASE_URL}/Archives/edgar/data/{cik_int}/{accession_path}/{accession_safe}-index.html"


def _normalize_cik(value: Any) -> str:
    digits = re.sub(r"\D+", "", str(value or ""))
    return digits.zfill(10) if digits else ""


def _normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _clean_text(value: Any) -> str | None:
    normalized = str(value or "").strip()
    return normalized or None


def _parse_date(value: Any) -> date | None:
    text = str(value or "").strip()
    if not text:
        return None
    candidates = [text, text[:10], text[:11]]
    for candidate in candidates:
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y%m%d", "%d-%b-%Y"):
            try:
                return datetime.strptime(candidate, fmt).date()
            except ValueError:
                continue
    return None


def _sequence_value(values: Any, index: int) -> Any:
    if isinstance(values, (list, tuple)) and index < len(values):
        return values[index]
    return None


def _first_zip_member(zf: zipfile.ZipFile, pattern: str) -> str | None:
    pattern_upper = pattern.upper()
    for name in zf.namelist():
        if pattern_upper in name.upper() and name.upper().endswith((".TSV", ".TXT", ".CSV")):
            return name
    return None


def _field(row: dict[str, Any], *names: str) -> str | None:
    lower_map = {key.lower(): value for key, value in row.items()}
    for name in names:
        value = lower_map.get(name.lower())
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default
