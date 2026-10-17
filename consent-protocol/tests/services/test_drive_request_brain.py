"""Deterministic request brain and the Gemini-free request flow."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import drive_request_bulk_service as bulk_module
from hushh_mcp.services import drive_trusted_auto_service as trusted_module
from hushh_mcp.services.drive_request_brain import (
    brain_from_checkpoint,
    interpret_request,
    suggested_plan,
)
from hushh_mcp.services.drive_request_bulk_service import (
    GEMINI_PLANNER_FLAG,
    DriveRequestBulkService,
)
from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService

NOW = datetime(2026, 10, 17, 6, tzinfo=UTC)


def brain(text, **kwargs):
    return interpret_request(text, now=NOW, timezone="Asia/Kolkata", **kwargs)


def spellings(result):
    return {variant for concept in result.concepts for variant in concept.variants}


@pytest.mark.parametrize(
    "text,doc_type,expected",
    [
        ("meeting notes", "meeting_notes", {"minutes", "mom", "transcript", "standup", "1:1"}),
        ("MoM", "meeting_notes", {"mom", "minutes of meeting"}),
        ("minutes of meeting", "meeting_notes", {"mom", "minutes"}),
        ("Notes by Gemini", "meeting_notes", {"notes by gemini"}),
        ("standup notes", "meeting_notes", {"standup", "recap", "notes"}),
        ("bank statements", "bank_statement", {"bank", "statement", "statements"}),
        ("credit card statements", "card_statement", {"credit card", "statement"}),
        ("invoices", "invoice", {"invoice", "bill", "receipt"}),
        ("salary slips", "payslip", {"payslip", "salary slip", "pay slip"}),
        ("ITR", "tax", {"itr", "income tax return"}),
        ("Form 16", "tax", {"form 16", "form16"}),
        ("26AS", "tax", {"26as", "form 26as"}),
        ("GST returns", "tax", {"gst", "gstr"}),
        ("agreements", "contract", {"contract", "agreement", "nda"}),
        ("offer letter", "offer_letter", {"offer letter", "appointment letter"}),
        ("ID proof", "id", {"passport", "aadhaar", "pan card"}),
        ("insurance policy", "insurance", {"insurance"}),
        ("quarterly reports", "report", {"report", "reports"}),
    ],
)
def test_lexicon_maps_common_request_kinds_to_drive_spellings(text, doc_type, expected):
    result = brain(text)
    assert doc_type in result.doc_types
    assert expected <= spellings(result)
    # Every brain output is a valid, model-free LiveSearchPlan.
    plan = LiveSearchPlan.model_validate(suggested_plan(result, text))
    assert plan.terms and plan.subject_complete is True


def test_unknown_words_are_and_concepts_and_listed_subjects_are_a_union():
    falcon = brain("Project Falcon roadmap")
    assert [concept.canonical for concept in falcon.topics] == ["project", "falcon", "roadmap"]
    assert ("roadmap", "roadmaps") == falcon.topics[2].variants
    union = brain("contracts and invoices")
    assert [part.key for part in union.parts] == ["contract", "invoice"]
    assert not union.topics
    either = brain("falcon or eagle")
    assert [[c.canonical for c in part.concepts] for part in either.parts] == [
        ["falcon"],
        ["eagle"],
    ]
    # A named issuer stays a required topic on the statement part.
    hdfc = brain("HDFC bank statements")
    assert [concept.canonical for concept in hdfc.topics] == ["hdfc"]


@pytest.mark.parametrize(
    "text,period",
    [
        ("meeting notes last 3 months", ("2026-07-17", "2026-10-17")),
        ("statements for September", ("2026-09-01", "2026-09-30")),
        ("invoices Q3", ("2026-07-01", "2026-09-30")),
        # A month that has not started yet this year means last year's.
        ("statements for November", ("2025-11-01", "2025-11-30")),
        ("payslips this year", ("2026-01-01", "2026-10-17")),
        ("Form 16 FY 2024-25", ("2024-04-01", "2025-03-31")),
        ("notes from yesterday", ("2026-10-16", "2026-10-16")),
    ],
)
def test_date_phrases_leave_the_subject_and_only_suggest_a_period(text, period):
    result = brain(text)
    assert (result.suggested_period["start"], result.suggested_period["end"]) == period
    words = {variant for variant in spellings(result)}
    assert not words & {"last", "months", "september", "november", "q3", "year", "fy", "yesterday"}
    plan = suggested_plan(result, text)
    # The picked request dates stay the only filter: no plan date fields.
    assert "date_from" not in plan and "relative_days" not in plan


def test_may_is_a_month_only_with_a_date_cue():
    assert brain("notes from May 2026").suggested_period == {
        "start": "2026-05-01",
        "end": "2026-05-31",
    }
    assert brain("may I have the invoices").suggested_period is None


def test_kind_words_become_a_mime_kind_not_search_words():
    assert brain("offer letter pdf").file_kind == "pdf"
    assert brain("budget sheets").file_kind == "spreadsheet"
    assert brain("pitch decks").file_kind == "presentation"
    assert brain("receipt photos").file_kind == "image"
    assert brain("meeting notes").file_kind == "document"
    assert brain("pdfs and sheets about falcon").file_kind == "any"
    assert "pdf" not in spellings(brain("offer letter pdf"))


def test_spelling_fix_without_vocabulary_only_completes_a_known_phrase():
    fixed = brain("metting notes")
    assert fixed.corrected and "meeting_notes" in fixed.doc_types
    # The typed spelling is kept: a misspelled title is still found.
    assert {"meeting", "metting"} <= spellings(fixed)
    assert "statement" in spellings(brain("bank statment"))
    # Negative controls: real words are never rewritten without evidence.
    setting = brain("setting notes")
    assert not setting.corrected and "meeting" not in spellings(setting)
    assert not brain("metting").corrected


def test_spelling_fix_uses_the_owner_vocabulary_only_for_absent_words():
    vocabulary = {"falcon", "roadmap", "invoice", "kickoff"}
    assert "falcon" in spellings(brain("falcn roadmap", vocabulary=vocabulary)) - {"falcn"}
    invoice = brain("invocie", vocabulary=vocabulary)
    assert "invoice" in invoice.doc_types and "invocie" in spellings(invoice)
    # Present words, short words and far words are left alone.
    assert not brain("roadmap", vocabulary=vocabulary).corrected
    assert not brain("kick", vocabulary=vocabulary).corrected
    assert not brain("budget", vocabulary=vocabulary).corrected


def test_brain_round_trips_through_the_checkpoint_and_rejects_tampering():
    result = brain("Falcon meeting notes September")
    saved = result.as_checkpoint()
    assert brain_from_checkpoint(saved) == result
    tampered = {**saved, "topics": [{"canonical": "x", "variants": ["y"]}]}
    assert brain_from_checkpoint(tampered) is None
    assert brain_from_checkpoint({**saved, "version": 99}) is None


CONTEXT = {
    "purpose": {
        "purpose": "meeting notes",
        "periodStart": "2026-09-01",
        "periodEnd": "2026-09-30",
    },
    "revision": 3,
    "status": "pending",
    "searchStarted": False,
}


def _forbid_gemini(monkeypatch):
    """Every way the request planner could reach Gemini records and raises."""
    import google.genai.client as genai_client

    from hushh_mcp.hushh_adk import single_turn
    from hushh_mcp.services import drive_suggestion_service as suggestion

    reached = []

    def forbidden(*args, **kwargs):
        reached.append("gemini")
        raise AssertionError("Gemini reached from the request flow")

    async def forbidden_async(*args, **kwargs):
        return forbidden()

    monkeypatch.setattr(suggestion, "interpret_live_search", forbidden_async)
    monkeypatch.setattr(bulk_module, "interpret_live_search", forbidden_async)
    monkeypatch.setattr(suggestion, "build_single_turn_agent", forbidden)
    monkeypatch.setattr(suggestion, "run_single_turn", forbidden_async)
    monkeypatch.setattr(single_turn, "LlmAgent", forbidden)
    monkeypatch.setattr(genai_client.Client, "__init__", forbidden)
    return reached


def _search():
    return SimpleNamespace(
        store=SimpleNamespace(
            by_client=AsyncMock(return_value=None),
            takeover_request=AsyncMock(return_value=None),
            clear_legacy_completed_request=AsyncMock(return_value=False),
        ),
        create_for_request=AsyncMock(return_value={"status": "queued", "jobId": "job"}),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("flag", [None, "false"])
async def test_owner_and_trusted_request_flows_never_construct_or_call_gemini(monkeypatch, flag):
    if flag is None:
        monkeypatch.delenv(GEMINI_PLANNER_FLAG, raising=False)
    else:
        monkeypatch.setenv(GEMINI_PLANNER_FLAG, flag)
    reached = _forbid_gemini(monkeypatch)
    search = _search()
    sharing = SimpleNamespace(request_bulk_context=AsyncMock(return_value=CONTEXT))

    # Owner route: the production factory constructs the service with defaults.
    owner = DriveRequestBulkService(sharing=sharing, search=search, require_owner=AsyncMock())
    await owner.start_search(user_id="owner", request_id="request-1", timezone="Asia/Kolkata")

    # Trusted background preparation constructs its own default service.
    monkeypatch.setattr(bulk_module, "DriveOwnerSearchService", lambda: search)
    trusted_sharing = SimpleNamespace(
        db=object(),
        request_bulk_context=AsyncMock(return_value=CONTEXT),
        due_trusted_searches=AsyncMock(
            return_value=[{"user_id": "owner", "request_id": "request-2"}]
        ),
        trusted_request_authority=AsyncMock(),
        defer_trusted_search=AsyncMock(),
    )
    auto = DriveTrustedAutoService(
        sharing=trusted_sharing, bulk=SimpleNamespace(), payment=SimpleNamespace(), wake=AsyncMock()
    )
    outcome = await auto.start_pending(max_jobs=1)

    assert reached == []
    assert outcome == {"started": 1, "deferred": 0}
    trusted_sharing.defer_trusted_search.assert_not_awaited()
    assert search.create_for_request.await_count == 2
    for call in search.create_for_request.await_args_list:
        kwargs = call.kwargs
        # The skipped model stage is recorded in the frozen checkpoint inputs.
        assert kwargs["plan_source"] == "deterministic_brain"
        assert brain_from_checkpoint(kwargs["brain"]).doc_types == ("meeting_notes",)
        assert kwargs["plan"]["terms"] == ["meeting", "notes"]
        assert "planner_fallback" not in kwargs
    assert trusted_module.DriveRequestBulkService is DriveRequestBulkService


@pytest.mark.asyncio
async def test_gemini_planner_runs_only_when_the_operator_opts_in(monkeypatch):
    # Negative control: the guards above do catch a model call.
    monkeypatch.setenv(GEMINI_PLANNER_FLAG, "true")
    reached = _forbid_gemini(monkeypatch)
    search = _search()
    sharing = SimpleNamespace(request_bulk_context=AsyncMock(return_value=CONTEXT))
    service = DriveRequestBulkService(sharing=sharing, search=search, require_owner=AsyncMock())
    await service.start_search(user_id="owner", request_id="request-1")
    assert reached  # the opt-in planner was asked (and refused here)
    kwargs = search.create_for_request.await_args.kwargs
    # The meeting-notes failure fallback is recorded, never silent.
    assert kwargs["plan_source"] == "model"
    assert kwargs["planner_fallback"]["plan"] == "meeting_notes"
    assert "brain" not in kwargs
