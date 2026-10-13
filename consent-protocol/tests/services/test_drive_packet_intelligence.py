"""Evidence integrity cannot be supplied by the model's confidence score."""

from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_packet_contract import PageCitation, PricingAssessment
from hushh_mcp.services.drive_packet_intelligence import (
    consolidate_facts,
    extract_page_facts,
    verify_packet,
)


def page_facts():
    return {
        "pages": [1, 2],
        "document_type": None,
        "issuer": {"value": "Schwab", "citations": [{"page": 2, "quote": "Schwab"}]},
        "subject": None,
        "account": None,
        "periods": [],
        "topics": [],
        "facts": [],
        "missing_information": [],
        "ambiguous": False,
    }


def test_provider_schema_projection_preserves_host_bounds():
    assert "maxLength" not in PageCitation.model_json_schema()["properties"]["quote"]
    with pytest.raises(ValueError):
        PageCitation(page=1, quote="x" * 1001)
    with pytest.raises(ValueError):
        PricingAssessment(
            rubric_version="drive-packet-price-v1",
            useful_scope="single",
            coverage="complete",
            quality="verified",
            rationale="One verified period",
            suggested_price_cents=50001,
        )


@pytest.mark.parametrize("failure", ["invented_quote", "missing_page", "wrong_location_kind"])
async def test_extraction_rejects_missing_or_fabricated_evidence(failure):
    result = page_facts()
    if failure == "invented_quote":
        result["issuer"]["citations"][0]["quote"] = "Charles Schwab"
    elif failure == "missing_page":
        result["pages"] = [2]
    else:
        result["issuer"]["citations"][0]["unit_kind"] = "text_segment"
    with pytest.raises(ValueError):
        await extract_page_facts(
            user_id="owner",
            pages=[
                {"page": 1, "text": "Cover page"},
                {"page": 2, "text": "Schwab statement"},
            ],
            interpret=AsyncMock(return_value=result),
        )


async def test_consolidation_cannot_create_citations_or_packets_before_all_pages():
    pages = page_facts()
    folded = {key: value for key, value in pages.items() if key != "pages"}
    folded["canonical_packets"] = []
    assert (
        await consolidate_facts(
            user_id="owner",
            previous=None,
            page_facts=[pages],
            complete=False,
            interpret=AsyncMock(return_value=folded),
        )
    ).issuer.value == "Schwab"
    folded["canonical_packets"] = [
        {"key": "schwab-2026", "title": "Statements", "description": "Statements"}
    ]
    with pytest.raises(ValueError, match="unprocessed"):
        await consolidate_facts(
            user_id="owner",
            previous=None,
            page_facts=[pages],
            complete=False,
            interpret=AsyncMock(return_value=folded),
        )
    folded["canonical_packets"] = []
    folded["issuer"] = {"value": "Schwab", "citations": [{"page": 3, "quote": "Schwab"}]}
    with pytest.raises(ValueError, match="unsupported"):
        await consolidate_facts(
            user_id="owner",
            previous=None,
            page_facts=[pages],
            complete=True,
            interpret=AsyncMock(return_value=folded),
        )


async def test_checker_cannot_make_incomplete_evidence_ready():
    result = {
        "state": "ready",
        "correct_subject_and_account": True,
        "correct_issuer_and_type": True,
        "correct_coverage": True,
        "no_unrelated_inclusions": True,
        "no_unexplained_omissions": True,
        "issues": [],
    }
    with pytest.raises(ValueError, match="incomplete evidence"):
        await verify_packet(
            user_id="owner",
            packet={},
            documents=[],
            complete=False,
            interpret=AsyncMock(return_value=result),
        )


@pytest.mark.parametrize(
    "proposal",
    [
        {"decision": "no_match", "selected_document_refs": []},
        {"state": "incomplete", "selected_document_ids": ["source"]},
        {"state": "ready", "selected_document_ids": []},
    ],
)
async def test_correct_abstention_is_not_a_deliverable_ready_packet(proposal):
    result = {
        "state": "ready",
        "correct_subject_and_account": True,
        "correct_issuer_and_type": True,
        "correct_coverage": True,
        "no_unrelated_inclusions": True,
        "no_unexplained_omissions": True,
        "issues": [],
    }
    with pytest.raises(ValueError, match="nonready proposal"):
        await verify_packet(
            user_id="owner",
            packet=proposal,
            documents=[],
            complete=True,
            interpret=AsyncMock(return_value=result),
        )
