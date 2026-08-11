"""Reading a claimed adviser's Form ADV Part 2A into their profile.

The fixtures below are trimmed from the real filing for Olympus Peaks
Financial, LLC (CRD 283040, brochure version 953234, 23 pages) — including the
two traps that filing sets:

* the fee schedule is TIERED and NEGOTIABLE ("$0 - $250,000 1.25% ... Fees for
  portfolio management services are negotiable"), so publishing "1.25%" as the
  fee would misstate it; and
* the word "minimum" appears exactly once in 23 pages, in the sentence "There
  is no account minimum for any of OPFL's services" — a keyword grab would
  publish a number the filing explicitly denies.

Nothing here touches the network or a real model, and no PDF is committed.
"""

from __future__ import annotations

import json
import re
import sys
import types
from pathlib import Path
from typing import Any

import asyncpg
import httpx
import pytest

import hushh_mcp.runtime_providers as runtime_providers
import hushh_mcp.services.ria_brochure_profile_service as brochure_module
from hushh_mcp.services.ria_brochure_profile_service import (
    BIO_CONNECTIVE_TOKENS,
    build_factual_bio,
    enrich_claimed_profile,
    extract_profile_from_brochure,
    select_brochure,
    strip_table_of_contents,
    validate_model_payload,
)
from hushh_mcp.services.ria_claim_service import RIAClaimService
from hushh_mcp.services.ria_iam_service import RIAIAMService
from tests.test_ria_claim_flow import (
    _EVALUATE_VERIFIED,
    _TEST_UID,
    _FakeIamService,
    _FakeIdentityClient,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "db" / "migrations"
MANIFEST_PATH = REPO_ROOT / "db" / "release_migration_manifest.json"
CONTRACTS_DIR = REPO_ROOT / "db" / "contracts"
MIGRATION = "139_ria_profile_brochure_provenance.sql"
ROLLBACK = "139_ria_profile_brochure_provenance_down.sql"
PROVENANCE_COLUMNS = ("profile_source", "profile_source_url", "profile_source_filed_on")

_PROFILE_ID = "11111111-2222-3333-4444-555555555555"
_PART_2A_URL = (
    "https://files.adviserinfo.sec.gov/IAPD/Content/Common/"
    "crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=953234"
)
_PART_2B_URL = (
    "https://files.adviserinfo.sec.gov/IAPD/Content/Common/"
    "crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=910903"
)

# Exactly as the claim snapshot stores them (see _shape_firm).
_BROCHURES = [
    {"name": "ADV PART 2B-MAXFIELD", "date_submitted": "1/13/2026", "url": _PART_2B_URL},
    {
        "name": "ADV PART 2A-OLYMPUS PEAKS FINANCIAL, LLC",
        "date_submitted": "1/13/2026",
        "url": _PART_2A_URL,
    },
]

# The contents table: dotted leaders, page numbers, and the same headers the
# body uses. Searching the raw text for "Advisory Business" hits this first.
_TOC_TEXT = """Item 1 Cover Page
Table of Contents
Item 4 Advisory Business .................................................. 4
Item 5 Fees and Compensation .............................................. 5
Item 7 Types of Clients ................................................... 7
"""

_BODY_TEXT = """Item 4 Advisory Business
Olympus Peaks Financial, LLC ("OPFL") provides Portfolio Management services
to its clients. A financial plan is included at no additional fee for clients
who engage OPFL for ongoing Portfolio Management.
Item 5 Fees and Compensation
Portfolio Management Fees
Total Assets Under Management Annual Fees
$0 - $250,000 1.25%
$250,001 - $1,000,000 1.00%
$1,000,001 - And Up 0.50%
Fees for portfolio management services are negotiable.
There is no account minimum for any of OPFL's services.
Item 7 Types of Clients
Individuals
High-Net-Worth Individuals
Pension and Profit-Sharing Plans
"""

_BROCHURE_TEXT = _TOC_TEXT + _BODY_TEXT

_FIRM_RECORD = {
    "crd": 283040,
    "name": "OLYMPUS PEAKS FINANCIAL, LLC",
    "city": "SANDY",
    "state": "UT",
    "registration_type": "sec",
    "registration_status": "APPROVED",
    "brochures": _BROCHURES,
}

_ADVISOR_RECORD = {
    "crd": 5308823,
    "registered_since": "2016-05-13",
    "exams": [
        {"code": "Series 66", "name": "Uniform Combined State Law"},
        {"code": "SIE", "name": "Securities Industry Essentials"},
        {"code": "Series 7", "name": "General Securities Representative"},
    ],
    "branch": {"city": "SANDY", "state": "UT", "private_residence": False},
}


def _metadata(**overrides: Any) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "claim_type": "individual",
        "display_name": "Reginald Troy Maxfield",
        "firm_crd": 283040,
        "individual_crd": 5308823,
        "firm_record": dict(_FIRM_RECORD),
        "advisor_record": dict(_ADVISOR_RECORD),
    }
    metadata.update(overrides)
    return metadata


# ---------------------------------------------------------------------------
# Fakes: HTTP, pdfplumber, the model
# ---------------------------------------------------------------------------


def _fake_http(monkeypatch, handler) -> list[str]:
    """Route every AsyncClient in the module through a MockTransport."""
    requested: list[str] = []
    real_client = httpx.AsyncClient

    def _factory(*args: Any, **kwargs: Any):
        def _wrapped(request: httpx.Request) -> httpx.Response:
            requested.append(str(request.url))
            return handler(request)

        kwargs["transport"] = httpx.MockTransport(_wrapped)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(brochure_module.httpx, "AsyncClient", _factory)
    return requested


def _pdf_response(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, content=b"%PDF-1.7 fake bytes", headers={"x-fake": "1"})


class _FakePage:
    def __init__(self, text: str, *, boom: bool = False) -> None:
        self._text = text
        self._boom = boom

    def extract_text(self) -> str:
        if self._boom:
            raise RuntimeError("page is malformed")
        return self._text


class _FakePdf:
    def __init__(self, pages: list[_FakePage]) -> None:
        self.pages = pages

    def __enter__(self) -> _FakePdf:
        return self

    def __exit__(self, *_exc: Any) -> bool:
        return False


def _fake_pdfplumber(monkeypatch, pages: list[_FakePage]) -> None:
    module = types.ModuleType("pdfplumber")
    module.open = lambda _stream: _FakePdf(pages)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pdfplumber", module)


class _FakeModels:
    def __init__(self, holder: _FakeModelClient) -> None:
        self._holder = holder

    async def generate_content(self, *, model: str, contents: str, config: Any) -> Any:
        self._holder.prompts.append(contents)
        self._holder.models.append(model)
        if isinstance(self._holder.response, Exception):
            raise self._holder.response
        return types.SimpleNamespace(text=self._holder.response)


class _FakeAio:
    def __init__(self, holder: _FakeModelClient) -> None:
        self.models = _FakeModels(holder)


class _FakeModelClient:
    def __init__(self, response: Any) -> None:
        self.response = response
        self.prompts: list[str] = []
        self.models: list[str] = []
        self.aio = _FakeAio(self)


def _fake_model(monkeypatch, response: Any) -> _FakeModelClient:
    client = _FakeModelClient(response)
    monkeypatch.setattr(runtime_providers, "build_managed_runtime_client", lambda _p: client)
    return client


def _wire_happy_path(monkeypatch, *, model_json: str) -> _FakeModelClient:
    _fake_http(monkeypatch, _pdf_response)
    _fake_pdfplumber(monkeypatch, [_FakePage(_BROCHURE_TEXT)])
    return _fake_model(monkeypatch, model_json)


_GOOD_MODEL_JSON = json.dumps(
    {
        "services_offered": ["Portfolio management", "Financial planning"],
        "fee_structure": ["Percentage of assets under management"],
        "min_engagement_amount": None,
    }
)


# ---------------------------------------------------------------------------
# Which brochure gets read
# ---------------------------------------------------------------------------


def test_part_2a_is_preferred_over_the_2b_supplement():
    """2B is a supplement about one person; it cannot describe the firm."""
    chosen = select_brochure(_BROCHURES)

    assert chosen["url"] == _PART_2A_URL
    assert chosen["name"] == "ADV PART 2A-OLYMPUS PEAKS FINANCIAL, LLC"
    assert chosen["filed_on"] == "1/13/2026"


def test_falls_back_to_any_brochure_when_no_2a_is_on_file():
    chosen = select_brochure([_BROCHURES[0]])

    assert chosen["url"] == _PART_2B_URL


def test_raw_identity_api_key_casing_is_accepted():
    """The snapshot stores date_submitted; the upstream API sends dateSubmitted."""
    chosen = select_brochure(
        [{"name": "ADV PART 2A-X", "dateSubmitted": "1/13/2026", "url": _PART_2A_URL}]
    )

    assert chosen["filed_on"] == "1/13/2026"


@pytest.mark.parametrize(
    "brochures",
    [[], None, "not a list", [{"name": "ADV PART 2A"}], [{"url": ""}], [None]],
)
async def test_no_usable_brochure_is_an_empty_result_not_a_crash(brochures):
    result = await extract_profile_from_brochure(brochures, firm_name="OLYMPUS PEAKS")

    assert result["error"] == "no_brochure_on_file"
    assert result["services_offered"] == []
    assert result["fee_structure"] == []
    assert result["min_engagement_amount"] is None


# ---------------------------------------------------------------------------
# Bounded fetch
# ---------------------------------------------------------------------------


async def test_oversized_brochure_is_refused_by_the_declared_length(monkeypatch):
    monkeypatch.setattr(brochure_module, "MAX_PDF_BYTES", 64)

    def _huge(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"z" * 4096)

    _fake_http(monkeypatch, _huge)

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert result["error"] == "brochure_too_large"
    assert result["services_offered"] == []
    # Provenance still names the filing we declined, so the refusal is legible.
    assert result["source_url"] == _PART_2A_URL


async def test_oversized_brochure_is_refused_mid_stream_when_the_length_is_absent(monkeypatch):
    """A server that sends no content-length still cannot make us hold it all."""
    monkeypatch.setattr(brochure_module, "MAX_PDF_BYTES", 64)

    def _streamed(_request: httpx.Request) -> httpx.Response:
        async def _chunks():
            for _ in range(16):
                yield b"z" * 32

        return httpx.Response(200, content=_chunks())

    _fake_http(monkeypatch, _streamed)

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert result["error"] == "brochure_too_large"


async def test_fetch_timeout_returns_an_empty_result_and_never_raises(monkeypatch):
    def _timeout(_request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    _fake_http(monkeypatch, _timeout)

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert result["error"] == "fetch_failed:ReadTimeout"
    assert result["services_offered"] == []
    assert result["fee_structure"] == []
    assert result["min_engagement_amount"] is None
    assert result["min_engagement_currency"] == "USD"


async def test_a_non_200_filing_is_an_empty_result(monkeypatch):
    _fake_http(monkeypatch, lambda _r: httpx.Response(404))

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert result["error"] == "fetch_status_404"


async def test_the_aspx_redirector_is_followed(monkeypatch):
    seen: list[str] = []

    def _redirect(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(".aspx"):
            return httpx.Response(302, headers={"location": "https://files.example/real.pdf"})
        return _pdf_response(request)

    seen = _fake_http(monkeypatch, _redirect)
    _fake_pdfplumber(monkeypatch, [_FakePage(_BROCHURE_TEXT)])
    _fake_model(monkeypatch, _GOOD_MODEL_JSON)

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert seen[-1] == "https://files.example/real.pdf"
    assert result["services_offered"] == ["Portfolio management", "Financial planning"]


# ---------------------------------------------------------------------------
# Bounded text extraction, and the table-of-contents trap
# ---------------------------------------------------------------------------


def test_only_the_first_pages_are_read(monkeypatch):
    _fake_pdfplumber(monkeypatch, [_FakePage(f"page {i}") for i in range(40)])

    text = brochure_module._extract_pdf_text(b"%PDF")

    assert text.count("page ") == brochure_module.MAX_PAGES
    assert "page 40" not in text


def test_one_malformed_page_does_not_lose_the_filing(monkeypatch):
    _fake_pdfplumber(
        monkeypatch,
        [_FakePage("first"), _FakePage("", boom=True), _FakePage("third")],
    )

    text = brochure_module._extract_pdf_text(b"%PDF")

    assert "first" in text
    assert "third" in text


def test_the_contents_table_is_stripped_before_anything_reads_the_text():
    """The headers appear twice; the dotted-leader copy is page numbers, not content."""
    stripped = strip_table_of_contents(_BROCHURE_TEXT)

    assert "Item 4 Advisory Business ....." not in stripped
    assert "Table of Contents" not in stripped
    # The body copies of the same headers survive.
    assert "Item 5 Fees and Compensation\n" in stripped
    assert "There is no account minimum for any of OPFL's services." in stripped
    # No orphaned page numbers were left behind as if they were content.
    assert not re.search(r"\.{3,}", stripped)


async def test_the_text_handed_to_the_model_is_capped(monkeypatch):
    monkeypatch.setattr(brochure_module, "MAX_TEXT_CHARS", 200)
    _fake_http(monkeypatch, _pdf_response)
    _fake_pdfplumber(monkeypatch, [_FakePage("word " * 5000)])
    client = _fake_model(monkeypatch, _GOOD_MODEL_JSON)

    await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    prompt = client.prompts[0]
    brochure_slice = prompt.split("BROCHURE TEXT:\n", 1)[1]
    assert len(brochure_slice.strip()) <= 200


async def test_a_filing_with_no_extractable_text_is_an_empty_result(monkeypatch):
    _fake_http(monkeypatch, _pdf_response)
    _fake_pdfplumber(monkeypatch, [_FakePage("   ")])

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert result["error"] == "no_text_extracted"


async def test_an_unreadable_pdf_is_an_empty_result(monkeypatch):
    _fake_http(monkeypatch, _pdf_response)
    module = types.ModuleType("pdfplumber")

    def _boom(_stream):
        raise ValueError("not a PDF")

    module.open = _boom  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pdfplumber", module)

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert result["error"] == "parse_failed:ValueError"


# ---------------------------------------------------------------------------
# The prompt, and what we refuse to publish
# ---------------------------------------------------------------------------


async def test_the_prompt_forbids_invention_and_names_the_absence_rule(monkeypatch):
    client = _wire_happy_path(monkeypatch, model_json=_GOOD_MODEL_JSON)

    await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS FINANCIAL, LLC")

    prompt = client.prompts[0]
    rules = " ".join(prompt.split())
    assert "Extract ONLY what this brochure states" in rules
    assert "Never guess" in rules
    assert "A stated absence is null, never zero and never a guessed figure." in rules
    assert "NEVER return a rate, a percentage, a dollar amount, a tier" in rules
    # The trap sentence itself reaches the model, so the null is a reading and
    # not an accident of the text being cut off.
    assert "There is no account minimum for any of OPFL's services." in prompt


async def test_a_tiered_negotiable_schedule_never_becomes_a_published_rate(monkeypatch):
    """1.25% is the top tier of a negotiable schedule, not "the fee"."""
    _wire_happy_path(
        monkeypatch,
        model_json=json.dumps(
            {
                "services_offered": ["Portfolio management"],
                "fee_structure": [
                    "1.25%",
                    "1.25% of assets under management",
                    "$5,000",
                    "25 bps",
                    "Percentage of assets under management",
                ],
                "min_engagement_amount": None,
            }
        ),
    )

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert result["fee_structure"] == ["Percentage of assets under management"]
    for entry in result["fee_structure"]:
        assert "%" not in entry
        assert not any(char.isdigit() for char in entry)


async def test_a_brochure_that_denies_a_minimum_publishes_no_minimum(monkeypatch):
    """ "There is no account minimum" must never become a number."""
    _wire_happy_path(monkeypatch, model_json=_GOOD_MODEL_JSON)

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert result["min_engagement_amount"] is None
    assert result["min_engagement_currency"] == "USD"
    assert result["services_offered"] == ["Portfolio management", "Financial planning"]
    assert "error" not in result
    assert result["source_url"] == _PART_2A_URL
    assert result["source_name"] == "ADV PART 2A-OLYMPUS PEAKS FINANCIAL, LLC"
    assert result["source_filed_on"] == "1/13/2026"


@pytest.mark.parametrize("stated", [0, 0.0, -5, "none", "no minimum", None, True, {"a": 1}])
def test_a_stated_absence_or_nonsense_minimum_is_null(stated):
    assert (
        validate_model_payload({"min_engagement_amount": stated})["min_engagement_amount"] is None
    )


@pytest.mark.parametrize(
    ("stated", "expected"),
    [(250000, 250000.0), (250000.0, 250000.0), ("$250,000", 250000.0)],
)
def test_a_minimum_the_brochure_actually_states_is_kept(stated, expected):
    parsed = validate_model_payload({"min_engagement_amount": stated})
    assert parsed["min_engagement_amount"] == expected


def test_an_absurd_minimum_is_treated_as_a_parse_artefact():
    """An AUM figure caught by mistake is not an engagement minimum."""
    assert (
        validate_model_payload({"min_engagement_amount": 9_000_000_000_000})[
            "min_engagement_amount"
        ]
        is None
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"services_offered": "Portfolio management"},
        {"services_offered": {"a": "b"}},
        {"services_offered": [1, 2, 3]},
        {"services_offered": [None, "", "   "]},
        {"fee_structure": 42},
        "not a dict",
        None,
        [],
    ],
)
def test_wrong_types_collapse_to_empty_rather_than_publishing_garbage(payload):
    parsed = validate_model_payload(payload)

    assert parsed["services_offered"] == []
    assert parsed["fee_structure"] == []
    assert parsed["min_engagement_amount"] is None


def test_duplicate_and_overlong_entries_are_dropped():
    parsed = validate_model_payload(
        {
            "services_offered": [
                "Portfolio management",
                "portfolio MANAGEMENT",
                "x" * 400,
                *[f"Service {i}" for i in range(30)],
            ]
        }
    )

    assert parsed["services_offered"][0] == "Portfolio management"
    assert "portfolio MANAGEMENT" not in parsed["services_offered"]
    assert len(parsed["services_offered"]) <= brochure_module.MAX_LIST_ITEMS
    assert all(len(entry) <= brochure_module.MAX_ITEM_CHARS for entry in parsed["services_offered"])


# ---------------------------------------------------------------------------
# Model faults
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("body", ["not json at all", "", "{unclosed", "null"])
async def test_malformed_model_json_is_an_empty_result_and_never_raises(monkeypatch, body):
    _wire_happy_path(monkeypatch, model_json=body)

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert result["error"] in {"model_json_invalid", "model_json_not_an_object"}
    assert result["services_offered"] == []
    assert result["fee_structure"] == []
    assert result["min_engagement_amount"] is None


async def test_a_model_returning_a_json_array_is_an_empty_result(monkeypatch):
    _wire_happy_path(monkeypatch, model_json='["Portfolio management"]')

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert result["error"] == "model_json_not_an_object"


async def test_a_model_that_raises_is_an_empty_result(monkeypatch):
    _fake_http(monkeypatch, _pdf_response)
    _fake_pdfplumber(monkeypatch, [_FakePage(_BROCHURE_TEXT)])
    _fake_model(monkeypatch, RuntimeError("quota exhausted"))

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert result["error"] == "model_failed:RuntimeError"


async def test_an_unavailable_model_client_is_an_empty_result(monkeypatch):
    _fake_http(monkeypatch, _pdf_response)
    _fake_pdfplumber(monkeypatch, [_FakePage(_BROCHURE_TEXT)])

    def _boom(_provider):
        raise RuntimeError("no managed runtime configured")

    monkeypatch.setattr(runtime_providers, "build_managed_runtime_client", _boom)

    result = await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    assert result["error"] == "model_unavailable:RuntimeError"


async def test_no_brochure_text_is_ever_logged(monkeypatch, caplog):
    _wire_happy_path(monkeypatch, model_json="not json")
    caplog.set_level("DEBUG")

    await extract_profile_from_brochure(_BROCHURES, firm_name="OLYMPUS PEAKS")

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "no account minimum" not in logged
    assert "1.25%" not in logged


# ---------------------------------------------------------------------------
# The factual bio
# ---------------------------------------------------------------------------


def test_a_full_record_produces_a_factual_sentence():
    bio = build_factual_bio(_metadata())

    assert bio == (
        "Reginald Troy Maxfield is an investment adviser at Olympus Peaks Financial, LLC "
        "in Sandy, UT. SEC-registered since 2016 (CRD 5308823). Series 66, SIE, Series 7."
    )


def test_a_firm_claim_describes_the_firm():
    bio = build_factual_bio(_metadata(claim_type="firm", display_name="", advisor_record={}))

    assert (
        bio
        == "Olympus Peaks Financial, LLC is an investment adviser firm in Sandy, UT. SEC-registered (CRD 283040)."
    )


def test_a_state_registered_firm_is_not_called_sec_registered():
    firm = dict(_FIRM_RECORD, registration_type="state")
    bio = build_factual_bio(_metadata(firm_record=firm))

    assert "State-registered" in bio
    assert "SEC-registered" not in bio


def test_a_private_residence_branch_never_reaches_the_bio():
    advisor = dict(
        _ADVISOR_RECORD,
        branch={"city": "DRAPER", "state": "UT", "private_residence": True},
    )
    firm = dict(_FIRM_RECORD, city="SANDY", state="UT")
    bio = build_factual_bio(_metadata(advisor_record=advisor, firm_record=firm))

    assert "Draper" not in bio
    assert "Sandy, UT" in bio


@pytest.mark.parametrize(
    "metadata",
    [
        {},
        None,
        "not a dict",
        {"claim_type": "individual"},
        {"claim_type": "firm", "firm_record": {}},
        # A name and nothing else is not a bio.
        {"claim_type": "individual", "display_name": "Reginald Troy Maxfield"},
    ],
)
def test_thin_facts_produce_no_bio(metadata):
    assert build_factual_bio(metadata) == ""


def test_the_bio_invents_no_word_that_was_not_supplied():
    """Every word is either a supplied fact or a listed connective. No adjectives."""
    metadata = _metadata()
    supplied = " ".join(
        [
            metadata["display_name"],
            str(metadata["firm_record"]["name"]),
            str(metadata["firm_record"]["city"]),
            str(metadata["firm_record"]["state"]),
            str(metadata["firm_crd"]),
            str(metadata["individual_crd"]),
            str(metadata["advisor_record"]["registered_since"]),
            " ".join(exam["code"] for exam in metadata["advisor_record"]["exams"]),
        ]
    ).lower()
    supplied_tokens = set(re.findall(r"[a-z0-9]+", supplied))

    bio = build_factual_bio(metadata)

    for token in re.findall(r"[a-z0-9]+", bio.lower()):
        assert token in supplied_tokens or token in BIO_CONNECTIVE_TOKENS, (
            f"the bio invented {token!r}"
        )


def test_the_bio_makes_no_claim_about_quality_or_specialisation():
    bio = build_factual_bio(_metadata()).lower()

    for word in (
        "experienced",
        "trusted",
        "leading",
        "expert",
        "specialis",
        "specializ",
        "passionate",
        "dedicated",
        "helps",
        "clients",
        "wealth",
    ):
        assert word not in bio


# ---------------------------------------------------------------------------
# The write: blanks only, never an adviser's own words
# ---------------------------------------------------------------------------


class _FakeProfileConn:
    """Captures the UPDATE so its blanks-only guards can be read back."""

    def __init__(self, *, provenance_missing: bool = False, filled: bool = True) -> None:
        self.provenance_missing = provenance_missing
        self.filled = filled
        self.queries: list[tuple[str, tuple[Any, ...]]] = []

    async def fetchrow(self, query: str, *args: Any):
        if self.provenance_missing and "profile_source" in query:
            raise asyncpg.exceptions.UndefinedColumnError("column does not exist")
        self.queries.append((query, args))
        return {"filled": self.filled}

    async def close(self) -> None:
        return None


def _iam(monkeypatch, conn: _FakeProfileConn) -> RIAIAMService:
    service = RIAIAMService()

    async def _fake_conn():
        return conn

    monkeypatch.setattr(service, "_conn", _fake_conn)
    return service


async def _write(service: RIAIAMService, **overrides: Any) -> bool:
    kwargs: dict[str, Any] = {
        "services_offered": ["Portfolio management"],
        "fee_structure": ["Percentage of assets under management"],
        "min_engagement_amount": None,
        "min_engagement_currency": "USD",
        "bio": "Reginald Troy Maxfield is an investment adviser at Olympus Peaks Financial, LLC.",
        "profile_source": "form_adv_part2",
        "profile_source_url": _PART_2A_URL,
        "profile_source_filed_on": "1/13/2026",
    }
    kwargs.update(overrides)
    return await service.apply_brochure_profile_fields(_PROFILE_ID, **kwargs)


async def test_the_write_can_only_fill_blanks_and_never_overwrites_typed_values(monkeypatch):
    conn = _FakeProfileConn()
    await _write(_iam(monkeypatch, conn))

    query = " ".join(conn.queries[0][0].split())

    # Each field is guarded by whether the STORED value is blank, so anything
    # the adviser typed survives untouched.
    assert "COALESCE(array_length(services_offered, 1), 0) = 0 AS services_blank" in query
    assert "COALESCE(array_length(fee_structure, 1), 0) = 0 AS fees_blank" in query
    assert "min_engagement_amount IS NULL AS minimum_blank" in query
    assert "COALESCE(NULLIF(bio, ''), '') = '' AS bio_blank" in query
    for guard in (
        "services_offered = CASE WHEN t.services_blank",
        "fee_structure = CASE WHEN t.fees_blank",
        "min_engagement_amount = CASE WHEN t.minimum_blank",
        "bio = CASE WHEN t.bio_blank",
    ):
        assert guard in query, f"missing blanks-only guard: {guard}"
    # No unguarded assignment of an incoming value anywhere in the statement.
    for column in ("services_offered", "fee_structure", "min_engagement_amount", "bio"):
        assert f"{column} = $" not in query
    # The brochure lane touches nothing outside the narrative block.
    for untouched in (
        "display_name",
        "legal_name",
        "finra_crd",
        "verification_status",
        "certifications",
        "strategy",
    ):
        assert untouched not in query


async def test_provenance_is_stamped_only_when_a_blank_was_actually_filled(monkeypatch):
    conn = _FakeProfileConn()
    await _write(_iam(monkeypatch, conn))

    query = " ".join(conn.queries[0][0].split())

    for column in PROVENANCE_COLUMNS:
        assert f"{column} = CASE WHEN t.fills_blank" in query


async def test_the_write_reports_whether_anything_was_filled(monkeypatch):
    assert await _write(_iam(monkeypatch, _FakeProfileConn(filled=True))) is True
    assert await _write(_iam(monkeypatch, _FakeProfileConn(filled=False))) is False


async def test_an_empty_profile_id_writes_nothing(monkeypatch):
    conn = _FakeProfileConn()
    service = _iam(monkeypatch, conn)

    assert await service.apply_brochure_profile_fields("  ") is False
    assert conn.queries == []


async def test_the_values_still_land_when_the_provenance_migration_has_not_run(monkeypatch):
    """A deploy can precede its migration; only the label waits, not the data."""
    conn = _FakeProfileConn(provenance_missing=True)

    assert await _write(_iam(monkeypatch, conn)) is True

    query, args = conn.queries[0]
    assert "profile_source" not in query
    assert len(args) == 6
    assert args[1] == ["Portfolio management"]


async def test_blank_incoming_values_are_passed_through_as_empty_not_null(monkeypatch):
    conn = _FakeProfileConn()
    await _write(_iam(monkeypatch, conn), services_offered=None, fee_structure=[], bio="")

    _, args = conn.queries[0]
    assert args[1] == []
    assert args[2] == []
    assert args[5] == ""


# ---------------------------------------------------------------------------
# Post-claim dispatch
# ---------------------------------------------------------------------------


class _RecordingIam:
    def __init__(self, *, boom: bool = False, filled: bool = True) -> None:
        self.boom = boom
        self.filled = filled
        self.calls: list[dict[str, Any]] = []

    async def apply_brochure_profile_fields(self, profile_id: str, **kwargs: Any) -> bool:
        if self.boom:
            raise RuntimeError("profile write failed")
        self.calls.append({"profile_id": profile_id, **kwargs})
        return self.filled


async def test_enrichment_writes_the_brochure_fields_and_the_bio(monkeypatch):
    _wire_happy_path(monkeypatch, model_json=_GOOD_MODEL_JSON)
    iam = _RecordingIam()

    status = await enrich_claimed_profile(
        ria_profile_id=_PROFILE_ID,
        reference_metadata=_metadata(),
        iam_service=iam,
    )

    assert status == {"status": "written"}
    call = iam.calls[0]
    assert call["profile_id"] == _PROFILE_ID
    assert call["services_offered"] == ["Portfolio management", "Financial planning"]
    assert call["fee_structure"] == ["Percentage of assets under management"]
    assert call["min_engagement_amount"] is None
    assert call["profile_source"] == "form_adv_part2"
    assert call["profile_source_url"] == _PART_2A_URL
    assert call["profile_source_filed_on"] == "1/13/2026"
    assert call["bio"].startswith("Reginald Troy Maxfield is an investment adviser")


async def test_a_bio_only_write_claims_no_brochure_provenance(monkeypatch):
    """Restating facts already on the profile is not "from the SEC filing"."""
    _fake_http(monkeypatch, lambda _r: httpx.Response(404))
    iam = _RecordingIam()

    await enrich_claimed_profile(
        ria_profile_id=_PROFILE_ID,
        reference_metadata=_metadata(),
        iam_service=iam,
    )

    call = iam.calls[0]
    assert call["services_offered"] == []
    assert call["profile_source"] == ""
    assert call["profile_source_url"] == ""
    assert call["bio"]


async def test_nothing_is_written_when_there_is_nothing_to_say(monkeypatch):
    _fake_http(monkeypatch, lambda _r: httpx.Response(404))
    iam = _RecordingIam()

    status = await enrich_claimed_profile(
        ria_profile_id=_PROFILE_ID,
        reference_metadata={"claim_type": "individual"},
        iam_service=iam,
    )

    assert status["status"] == "nothing_to_write"
    assert iam.calls == []


async def test_a_failing_profile_write_is_swallowed(monkeypatch):
    _wire_happy_path(monkeypatch, model_json=_GOOD_MODEL_JSON)

    status = await enrich_claimed_profile(
        ria_profile_id=_PROFILE_ID,
        reference_metadata=_metadata(),
        iam_service=_RecordingIam(boom=True),
    )

    assert status == {"status": "write_failed"}


async def test_enrichment_survives_an_extractor_that_raises(monkeypatch):
    async def _boom(*_args: Any, **_kwargs: Any):
        raise RuntimeError("the extractor broke its own contract")

    monkeypatch.setattr(brochure_module, "extract_profile_from_brochure", _boom)
    iam = _RecordingIam()

    status = await enrich_claimed_profile(
        ria_profile_id=_PROFILE_ID,
        reference_metadata=_metadata(),
        iam_service=iam,
    )

    # The bio needs no model, so it still lands.
    assert status == {"status": "written"}
    assert iam.calls[0]["services_offered"] == []
    assert iam.calls[0]["bio"]


async def test_a_missing_profile_id_is_a_skip(monkeypatch):
    status = await enrich_claimed_profile(ria_profile_id="", reference_metadata=_metadata())

    assert status == {"status": "skipped", "reason": "missing_profile_id"}


# ---------------------------------------------------------------------------
# The claim can never be failed by any of this
# ---------------------------------------------------------------------------


async def _complete_claim(service: RIAClaimService) -> dict[str, Any]:
    return await service.complete(
        user_id=_TEST_UID,
        phone_digits="8015663510",
        claim_type="individual",
        firm_crd=283040,
        individual_crd=5308823,
    )


def _claim_service() -> RIAClaimService:
    return RIAClaimService(
        client=_FakeIdentityClient(evaluate_payload=_EVALUATE_VERIFIED),
        iam_service=_FakeIamService(),
    )


async def test_claim_still_succeeds_when_the_whole_extraction_raises(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")

    def _boom(**_kwargs: Any):
        raise RuntimeError("brochure lane is down")

    monkeypatch.setattr(brochure_module, "dispatch_profile_enrichment", _boom)

    result = await _complete_claim(_claim_service())

    assert result["status"] == "claimed"
    assert result["facts"]["crd_number"] == "5308823"


async def test_the_claim_hands_the_profile_and_snapshot_to_the_brochure_lane(monkeypatch):
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    captured: dict[str, Any] = {}

    def _capture(**kwargs: Any) -> bool:
        captured.update(kwargs)
        return True

    monkeypatch.setattr(brochure_module, "dispatch_profile_enrichment", _capture)

    result = await _complete_claim(_claim_service())

    assert result["status"] == "claimed"
    assert captured["ria_profile_id"]
    metadata = captured["reference_metadata"]
    # The name the profile was built from travels with the snapshot, so the
    # factual bio never has to guess who it describes.
    assert metadata["display_name"] == "Reginald Troy Maxfield"
    assert metadata["firm_record"]["name"] == "OLYMPUS PEAKS FINANCIAL, LLC"


# ---------------------------------------------------------------------------
# Migration 139
# ---------------------------------------------------------------------------


def test_brochure_provenance_migration_is_registered_in_the_release_lane() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    assert MIGRATION in manifest["ordered_migrations"]
    assert MIGRATION in manifest["groups"]["iam"]
    assert manifest["ordered_migrations"].index(MIGRATION) > manifest["ordered_migrations"].index(
        "138_circle_member_connection_origin.sql"
    )
    assert len(manifest["ordered_migrations"]) == len(set(manifest["ordered_migrations"]))
    assert (MIGRATIONS_DIR / MIGRATION).exists()
    assert (MIGRATIONS_DIR / "rollback" / ROLLBACK).exists()


def test_brochure_provenance_migration_adds_only_nullable_labels() -> None:
    migration = (MIGRATIONS_DIR / MIGRATION).read_text(encoding="utf-8")

    assert "ALTER TABLE ria_profiles" in migration
    for column in PROVENANCE_COLUMNS:
        assert f"ADD COLUMN IF NOT EXISTS {column} TEXT" in migration
        # Nullable and undefaulted: a self-authored profile names no source.
        assert f"{column} TEXT NOT NULL" not in migration
        assert f"{column} TEXT DEFAULT" not in migration
    # A label migration writes no data and touches no other table.
    assert "INSERT INTO" not in migration
    assert "UPDATE ria_profiles" not in migration
    assert "DROP TABLE" not in migration


def test_brochure_provenance_is_covered_by_the_schema_contracts() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    highest = max(
        int(name.split("_", 1)[0]) for name in manifest["ordered_migrations"] if name[:3].isdigit()
    )
    # What matters here is that the brochure migration is registered and that
    # the contracts track the manifest head. Pinning the head to a fixed number
    # made every later migration fail this RIA test for an unrelated reason.
    assert MIGRATION in manifest["ordered_migrations"]
    assert highest >= int(MIGRATION.split("_", 1)[0])

    for contract_name in ("uat_integrated_schema.json", "prod_core_schema.json"):
        contract = json.loads((CONTRACTS_DIR / contract_name).read_text(encoding="utf-8"))
        assert contract["expected_migration_version"] == highest
        assert set(contract["required_tables"]["ria_profiles"]) >= set(PROVENANCE_COLUMNS)

    dev_contract = json.loads(
        (CONTRACTS_DIR / "dev_minimum_schema.json").read_text(encoding="utf-8")
    )
    assert dev_contract["expected_migration_version"] == highest


def test_brochure_provenance_rollback_drops_only_the_labels() -> None:
    rollback = (MIGRATIONS_DIR / "rollback" / ROLLBACK).read_text(encoding="utf-8")

    for column in PROVENANCE_COLUMNS:
        assert f"DROP COLUMN IF EXISTS {column}" in rollback
    # The values those labels described are live profile content.
    for kept in ("services_offered", "fee_structure", "min_engagement_amount", "bio"):
        assert f"DROP COLUMN IF EXISTS {kept}" not in rollback
    assert "DROP TABLE" not in rollback


def test_onboarding_status_returns_the_provenance_keys() -> None:
    """The UI can only label a filing's words if the status names the source."""
    source = (REPO_ROOT / "hushh_mcp" / "services" / "ria_iam_service.py").read_text(
        encoding="utf-8"
    )

    for column in PROVENANCE_COLUMNS:
        assert f'"{column}": profile_provenance.get("{column}")' in source
