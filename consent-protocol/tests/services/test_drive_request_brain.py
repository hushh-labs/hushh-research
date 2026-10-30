"""Deterministic request brain and the Gemini-free request flow."""

from datetime import UTC, date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import drive_request_bulk_service as bulk_module
from hushh_mcp.services import drive_trusted_auto_service as trusted_module
from hushh_mcp.services.drive_owner_search_service import (
    _brain_title_evidence,
    _note_candidate,
    _trusted_subject_matches,
)
from hushh_mcp.services.drive_request_brain import (
    _ENTRIES,
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
from hushh_mcp.services.google_drive_adapter import DriveReadError

NOW = datetime(2026, 10, 17, 6, tzinfo=UTC)


def brain(text, **kwargs):
    return interpret_request(text, now=NOW, timezone="Asia/Kolkata", **kwargs)


def spellings(result):
    return {variant for concept in result.concepts for variant in concept.variants}


def evidence(concept):
    return set(concept.title_evidence)


@pytest.mark.parametrize(
    "text,doc_type,expected",
    [
        ("meeting notes", "meeting_notes", {"minutes", "transcript", "standup", "1:1", "mtg"}),
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
        # A trigger that consumes "document(s)" still asks for documents.
        ("tax documents for FY 2024-25", "tax", {"tax"}),
        ("my tax documents", "tax", {"tax"}),
        ("tax document", "tax", {"tax"}),
        ("identity documents", "id", {"identity"}),
        ("identity document for KYC", "id", {"identity", "kyc"}),
        ("policy document", "insurance", {"insurance"}),
        ("HDFC policy document", "insurance", {"insurance"}),
    ],
)
def test_lexicon_maps_common_request_kinds_to_drive_spellings(text, doc_type, expected):
    result = brain(text)
    assert doc_type in result.doc_types
    assert expected <= spellings(result)
    # Every brain output is a valid, model-free LiveSearchPlan that the host's
    # request-consistency rules accept (a deterministic plan cannot retry).
    plan = LiveSearchPlan.model_validate(suggested_plan(result, text))
    assert plan.terms and plan.subject_complete is True
    assert not DriveRequestBulkService._plan_mismatch(text, plan, require_statement_coverage=True)
    if "document" in text.casefold():
        assert plan.file_kind == "document"


def test_generic_meeting_notes_never_search_or_accept_lowercase_mom():
    generic = brain("meeting notes")
    # "mom" is the word mother once casefolded: not a meeting-notes spelling.
    assert "mom" not in spellings(generic)
    assert all(item.phrase != "mom" for part in generic.parts for item in part.standalone)
    assert all("mom" not in evidence(concept) for concept in generic.concepts)
    # Only a typed MoM searches "mom", and only the cased form is evidence.
    typed = brain("send MoM of last week")
    assert "mom" in spellings(typed)
    assert {"MoM", "MOM", "M.O.M"} <= evidence(typed.concepts[0])
    assert "mom" not in evidence(typed.concepts[0])


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
    assert brain("receipt photos").file_kind == "image"
    assert brain("meeting notes").file_kind == "document"
    assert brain("pdfs and sheets about falcon").file_kind == "any"
    assert brain("pdf invoices").file_kind == "pdf"
    assert "pdf" not in spellings(brain("offer letter pdf"))


@pytest.mark.parametrize(
    "text,words",
    [
        # A named document whose head is a file-type word is any file type.
        ("balance sheet", {"balance", "sheet"}),
        ("term sheet for series A", {"term", "sheet"}),
        ("cheat sheet", {"cheat", "sheet"}),
        ("pitch decks", {"pitch", "deck"}),
        # A file-type word before another subject word modifies it.
        ("video production invoice", {"video", "production"}),
        ("photo studio bill", {"photo", "studio"}),
        ("photo ID", {"photo"}),
    ],
)
def test_file_type_words_inside_a_noun_phrase_stay_search_words(text, words):
    result = brain(text)
    assert result.file_kind == "any"
    assert words <= {concept.canonical for concept in result.topics} | {
        variant for concept in result.topics for variant in concept.variants
    }


def test_spelling_fix_without_vocabulary_only_completes_a_known_phrase():
    fixed = brain("metting notes")
    assert fixed.corrected and "meeting_notes" in fixed.doc_types
    # The typed spelling is kept: a misspelled title is still found.
    assert {"meeting", "metting"} <= spellings(fixed)
    assert "statement" in spellings(brain("bank statment"))
    # The fix only discovers: what was typed is the only title evidence.
    assert _brain_title_evidence(fixed, "Metting notes draft.pdf")
    assert not _brain_title_evidence(fixed, "Team meeting notes.pdf")
    # Negative controls: real words are never rewritten without evidence.
    setting = brain("setting notes")
    assert not setting.corrected and "meeting" not in spellings(setting)
    assert not brain("metting").corrected


GEMINI_NOTES = (
    "HR 1:1 Priya - 2026/10/15 10:00 IST - Notes by Gemini",
    "Therapy - 2026/10/14 09:00 IST - Notes by Gemini",
)


@pytest.mark.parametrize(
    "text", ["fleeting notes", "teething notes", "greeting notes", "melting notes", "meeting nodes"]
)
def test_a_built_in_spelling_fix_never_authorizes_a_grant(text):
    result = brain(text)
    # Still discovered through the fixed phrase, for the owner's review.
    assert result.corrected and {"meeting", "notes"} <= spellings(result)
    # Never the generic ask: no Gemini or minutes-of-meeting alternative.
    phrases = {item.phrase for part in result.parts for item in part.standalone}
    assert not phrases & {"notes by gemini", "minutes of meeting", "mom"}
    for title in (*GEMINI_NOTES, "Team meeting notes.pdf", "Q3 planning MoM.docx"):
        assert not _brain_title_evidence(result, title), title
    # Positive control: the words as typed are title evidence.
    assert _brain_title_evidence(result, f"{text.title()} 2026-10-14.pdf")
    # Negative control: the literal generic ask still shares a Gemini note.
    assert all(titled("meeting notes", title) for title in GEMINI_NOTES)


def test_a_built_in_spelling_fix_never_turns_a_word_into_a_bank():
    blank = brain("blank statements")
    assert blank.corrected and "bank" in spellings(blank)
    assert not _brain_title_evidence(blank, "HDFC bank statement Sep 2026.pdf")
    assert _brain_title_evidence(blank, "Blank statement 2026-10-14.pdf")
    # Negative control: typed as it is, "bank statements" names the bank.
    assert titled("bank statements", "HDFC bank statement Sep 2026.pdf")


def test_spelling_fix_uses_the_owner_vocabulary_only_for_absent_words():
    vocabulary = {"falcon", "roadmap", "invoice", "kickoff"}
    falcon = brain("falcn roadmap", vocabulary=vocabulary)
    assert "falcon" in spellings(falcon) - {"falcn"}
    # The typed word stays the concept; the owner's word only discovers.
    assert falcon.topics[0].canonical == "falcn"
    assert "falcon" not in evidence(falcon.topics[0])
    invoice = brain("invocie", vocabulary=vocabulary)
    assert "invoice" in invoice.doc_types and "invocie" in spellings(invoice)
    assert "invoice" not in evidence(invoice.concepts[0])
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


def titled(text, title, **kwargs):
    """The automatic-sharing title rule for one title."""
    return _brain_title_evidence(brain(text, **kwargs), title)


@pytest.mark.parametrize(
    "text,unrelated,named",
    [
        # Loose clues discover candidates; only typed words and exact
        # synonyms are title evidence for an automatic grant.
        ("payslips", "Salary revision letter.pdf", "Salary slip Sep 2026.pdf"),
        ("payslips", "Salary benchmarks 2026.xlsx", "Pay slips - Sep.pdf"),
        ("insurance policy", "YouTube Premium receipt.pdf", "Health insurance policy.pdf"),
        ("offer letter", "Diwali offer flyer.pdf", "Offer letter - Acme.pdf"),
        ("offer letter", "Offer comparison vendors.xlsx", "Offer letters 2026.pdf"),
        ("meeting recap", "Earnings call summary.pdf", "Team meeting recap.pdf"),
        ("meeting notes", "Call notes with divorce lawyer.pdf", "Team meeting notes.pdf"),
        ("meeting notes", "Mom medical notes.pdf", "Mtg notes 3 Oct.docx"),
        ("credit card documents", "Aadhaar card.pdf", "HDFC credit card agreement.pdf"),
        ("credit card documents", "Report card - Aarav.pdf", "Credit cards summary.pdf"),
        ("invoices", "Hospital bill.pdf", "Invoice 42.pdf"),
        ("contracts", "Smith NDA.pdf", "Vendor contract.pdf"),
        ("ID proof", "Passport.pdf", "ID proof - Aadhaar.pdf"),
    ],
)
def test_only_typed_words_and_exact_synonyms_are_autoshare_title_evidence(text, unrelated, named):
    assert titled(text, named)
    assert not titled(text, unrelated)


@pytest.mark.parametrize(
    "text,vocabulary,wrong,typed",
    [
        ("Karan offer letter", {"kiran", "offer", "letter"}, "Kiran - Offer Letter.pdf", None),
        ("Mohan payslips", {"rohan", "payslip"}, "Rohan payslip Sep 2026.pdf", None),
        ("Smith contracts", {"smyth", "contract", "lease"}, "Smyth contract.pdf", None),
        ("audit report", {"audio", "report"}, "Audio report.pdf", "Audit report Q3.pdf"),
    ],
)
def test_owner_vocabulary_fixes_discover_but_never_authorize(text, vocabulary, wrong, typed):
    result = brain(text, vocabulary=vocabulary)
    fixed = next(word for word in vocabulary if word in spellings(result))
    assert result.corrected and fixed in spellings(result)  # still discovered
    assert result.topics[0].canonical == text.split()[0].casefold()
    assert not _brain_title_evidence(result, wrong)
    if typed:
        assert _brain_title_evidence(result, typed)
    # Negative control: without the hint nothing is rewritten.
    assert not brain(text).corrected


@pytest.mark.parametrize(
    "text",
    [
        "Hi, can you please send me the bank statements for September? Thanks!",
        "pls share bank statements asap",
        "Requesting the bank statements from your Google Drive",
        "Bank statements for visa application",
        "bank statements needed for home loan processing",
        "bank statements for my records",
    ],
)
def test_politeness_and_purpose_words_are_not_required_search_words(text):
    result = brain(text)
    assert result.topics == ()
    assert result.doc_types == ("bank_statement",)


def test_a_named_subject_after_for_is_still_required():
    assert [c.canonical for c in brain("invoices for Acme").topics] == ["acme"]
    assert "hdfc" in {c.canonical for c in brain("statements for HDFC home loan").topics}


def test_more_topics_than_the_bound_keep_the_most_specific():
    result = brain("blue green 48213 kickoff summary orange")
    assert len(result.topics) == 4
    assert "48213" in {concept.canonical for concept in result.topics}


@pytest.mark.parametrize(
    "text,name,title",
    [
        ("Rahul's offer letter", "rahul", "Rahul offer letter.pdf"),
        ("Priya\u2019s payslips", "priya", "Priya payslip Sep 2026.pdf"),
        ("Mom's passport", "mom", "Mom passport.pdf"),
    ],
)
def test_possessive_names_search_the_bare_name(text, name, title):
    result = brain(text)
    assert result.topics[0].canonical == name
    assert _brain_title_evidence(result, title)
    # A possessive is a person, never the MoM abbreviation.
    assert "meeting_notes" not in result.doc_types


def test_account_invoice_and_form_numbers_narrow_the_search():
    hdfc = brain("HDFC 4321 statement")
    assert "4321" in {concept.canonical for concept in hdfc.topics}
    assert _brain_title_evidence(hdfc, "HDFC 4321 statement Sep 2026.pdf")
    assert not _brain_title_evidence(hdfc, "HDFC 9876 statement Sep 2026.pdf")
    assert not titled("invoice 4512", "Invoice 7781.pdf")
    assert titled("invoice 4512", "Invoice_4512.pdf")
    assert not titled("1099 forms", "Leave application form.pdf")
    # Negative control: a count is a limit, never a search word.
    payslips = brain("latest 3 payslips")
    assert payslips.result_limit == 3 and not payslips.topics


OCTOBER = (date(2026, 10, 1), date(2026, 10, 17))


@pytest.mark.parametrize(
    "text,number,other,own,picked",
    [
        # Before a plural, a number after "Flat" names the flat; it is no count.
        (
            "Flat 302 maintenance bills",
            "302",
            "Flat 101 maintenance bill.pdf",
            "Flat 302 maintenance bill.pdf",
            OCTOBER,
        ),
        (
            "Flat #302 maintenance bills",
            "302",
            "Flat 101 maintenance bill.pdf",
            "Flat 302 maintenance bill.pdf",
            None,
        ),
        # A year-shaped number after an identifier noun, a future year, or a
        # year outside the picked dates names something; it is no period.
        ("invoice 2001", "2001", "Invoice 7781 2026-10-14.pdf", "Invoice 2001.pdf", None),
        ("HDFC 2045 statement", "2045", "HDFC 9876 statement.pdf", "HDFC 2045 statement.pdf", None),
        (
            "HDFC 2019 statement",
            "2019",
            "HDFC 9876 statement.pdf",
            "HDFC 2019 statement.pdf",
            OCTOBER,
        ),
    ],
)
def test_identifier_numbers_are_neither_counts_nor_years(text, number, other, own, picked):
    result = brain(text, picked_period=picked)
    assert number in {concept.canonical for concept in result.topics}
    assert result.result_limit is None and result.suggested_period is None
    assert _brain_title_evidence(result, own)
    assert not _brain_title_evidence(result, other)


def test_counts_and_years_without_an_identifier_still_leave_the_subject():
    # Negative controls for the identifier rule.
    assert brain("latest 3 payslips").result_limit == 3
    assert brain("send 100 invoices").result_limit == 100
    # A count cue keeps a count after an identifier noun.
    assert brain("flat latest 3 maintenance bills").result_limit == 3
    # A year inside the picked dates, or with none picked, is the period.
    for text, picked in (("statements 2026", OCTOBER), ("HDFC 2019 statement", None)):
        result = brain(text, picked_period=picked)
        assert result.suggested_period is not None
        assert not any(word.isdigit() for word in spellings(result))


@pytest.mark.parametrize(
    "text,dropped",
    [
        # Stopwords that can name the issuer or the subject.
        ("Google One receipts", ("one",)),
        ("Capital One statements", ("one",)),
        ("email me the invoices", ("email",)),
        ("hard drive invoice", ("drive",)),
        # A spaced "&" lists subjects and leaves single letters behind.
        ("AT & T bills", ("t",)),
        # A short number after an identifier noun names the record.
        ("Flat 12 maintenance bills", ("12",)),
        ("#12 maintenance bills", ("12",)),
        # Topic words past the bound.
        ("blue green 48213 kickoff summary orange", ("blue", "green")),
    ],
)
def test_words_that_may_name_the_subject_are_recorded_when_dropped(text, dropped):
    result = brain(text)
    assert result.dropped == dropped
    assert brain_from_checkpoint(result.as_checkpoint()) == result


@pytest.mark.parametrize(
    "text",
    [
        "Requesting the bank statements from your Google Drive",
        "invoices from my drive",
        "invoices in shared drives",
        "Hi, can you please send me the bank statements for September? Thanks!",
        "bank statements needed for home loan processing",
        "latest 3 payslips",
        "meeting notes last 3 months",
        "statements for two months",
        "send my google docs about falcon",
        "invoices 15 Sep",
        "send me Contract.pdf please",
    ],
)
def test_filler_politeness_date_count_and_location_words_are_not_dropped_subjects(text):
    # Negative control: these words never cost a request its automatic grant.
    assert brain(text).dropped == ()


@pytest.mark.parametrize(
    "text,issuer,unrelated,named",
    [
        ("AT&T bills", "at&t", "Electricity bill Sep 2026.pdf", "AT&T bill Sep 2026.pdf"),
        ("H&M receipts", "h&m", "Pharmacy receipt Sep 2026.pdf", "H&M receipt Sep 2026.pdf"),
        ("P&G invoices", "p&g", "AWS invoice 2026-10-14.pdf", "P&G invoice 2026-10-14.pdf"),
        ("Google invoices", "google", "Hospital invoice 2026-10-13.pdf", "Google invoice Sep.pdf"),
    ],
)
def test_ampersand_names_and_google_stay_required_issuers(text, issuer, unrelated, named):
    result = brain(text)
    assert [concept.canonical for concept in result.topics] == [issuer]
    assert result.dropped == ()
    assert titled(text, named)
    assert not titled(text, unrelated)
    # Negative control: Google Drive and Google Docs are where and what, not who.
    assert brain("bank statements from your Google Drive").topics == ()
    assert "google" not in spellings(brain("send my google docs about falcon"))


@pytest.mark.parametrize("kind", ["standup", "sync", "1:1"])
def test_specific_meeting_kinds_are_not_the_generic_meeting_notes_ask(kind):
    result = brain(f"{kind} notes")
    phrases = {item.phrase for part in result.parts for item in part.standalone}
    assert not phrases & {"notes by gemini", "minutes of meeting", "mom"}
    assert not _brain_title_evidence(
        result, "Board review - 2026/10/15 10:00 IST - Notes by Gemini"
    )
    assert not _brain_title_evidence(result, "Q3 planning MoM.docx")
    # Negative control: the literal generic ask keeps them.
    for generic in ("meeting notes", "mtg notes"):
        generic_brain = brain(generic)
        assert {"notes by gemini", "minutes of meeting"} <= {
            item.phrase for part in generic_brain.parts for item in part.standalone
        }


@pytest.mark.parametrize(
    "text,either,neither",
    [
        (
            "falcon or eagle invoices",
            ("Falcon invoice.pdf", "Eagle invoice.pdf"),
            "Hawk invoice.pdf",
        ),
        ("invoices from Acme or Globex", ("Acme invoice.pdf", "Globex invoices.pdf"), "Acme.pdf"),
        (
            "Acme or Globex contracts",
            ("Acme contract.pdf", "Globex contract.pdf"),
            "Initech contract.pdf",
        ),
    ],
)
def test_listed_subjects_with_a_document_type_are_either_or(text, either, neither):
    result = brain(text)
    assert len(result.topics) == 1 and result.parts
    assert all(_brain_title_evidence(result, title) for title in either)
    assert not _brain_title_evidence(result, neither)


def test_every_short_trigger_is_searched_and_counted_as_typed():
    for entry in _ENTRIES:
        for trigger in entry.triggers:
            if trigger in {"mom", "moms"} or {"document", "documents"} & set(trigger.split()):
                continue
            concept = brain(trigger).concepts[0]
            assert any(
                variant == trigger or trigger.startswith(variant) or variant.startswith(trigger)
                for variant in concept.variants
            ), trigger
            assert trigger in concept.title_evidence, trigger
    assert "dl" in spellings(brain("send my DL"))
    assert titled("send my DL", "DL front.jpg")
    assert titled("employee ID card", "Employee ID card.jpg")
    assert titled("1-1 notes", "1-1 Priya notes.docx")


@pytest.mark.parametrize(
    "text",
    ["please share the soft copy", "send the scanned copy", "the latest one", "send it please"],
)
@pytest.mark.asyncio
async def test_a_request_without_any_subject_fails_closed(text):
    service = DriveRequestBulkService(sharing=SimpleNamespace(), search=SimpleNamespace())
    purpose = {"purpose": text, "periodStart": "2026-09-01", "periodEnd": "2026-09-30"}
    with pytest.raises(DriveReadError, match="narrow_selection_required"):
        await service._brain_plan(user_id="owner", purpose=purpose, timezone="UTC")
    empty = brain(text)
    assert not empty.listing
    # A subject-free brain is never title evidence for every file.
    assert not _brain_title_evidence(empty, "Bank statement Sep.pdf")


@pytest.mark.parametrize(
    "text,kind",
    [
        ("all files from last week", "any"),
        ("September documents", "document"),
        ("Q3 documents", "document"),
        ("everything", "any"),
        ("latest 5 files", "any"),
    ],
)
@pytest.mark.asyncio
async def test_an_explicit_listing_still_plans(text, kind):
    service = DriveRequestBulkService(sharing=SimpleNamespace(), search=SimpleNamespace())
    purpose = {"purpose": text, "periodStart": "2026-07-01", "periodEnd": "2026-10-17"}
    plan, result = await service._brain_plan(user_id="owner", purpose=purpose, timezone="UTC")
    assert result.listing and plan.subject_scope == "metadata_listing" and not plan.terms
    assert plan.file_kind == kind
    assert _brain_title_evidence(result, "Anything.pdf")


@pytest.mark.parametrize("text", ["send me my will", "the list", "send my scans", "send my 1099"])
@pytest.mark.asyncio
async def test_content_words_once_dropped_are_subjects(text):
    service = DriveRequestBulkService(sharing=SimpleNamespace(), search=SimpleNamespace())
    purpose = {"purpose": text, "periodStart": "2026-09-01", "periodEnd": "2026-09-30"}
    plan, result = await service._brain_plan(user_id="owner", purpose=purpose, timezone="UTC")
    assert plan.terms and result.topics and not result.listing
    assert not _brain_title_evidence(result, "Bank statement Sep.pdf")


def test_counts_and_literal_file_names_bound_the_selection():
    latest = brain("latest 3 payslips")
    plan = LiveSearchPlan.model_validate(suggested_plan(latest, "latest 3 payslips"))
    assert plan.result_limit == 3 and plan.sort == "recent" and plan.terms == ["payslip"]
    assert brain("2 invoices").result_limit == 2
    # Names and time spans are not counts.
    assert brain("Form 16 docs").result_limit is None
    assert brain("12 months statements").result_limit is None
    named = brain("send me Contract.pdf please")
    plan = LiveSearchPlan.model_validate(suggested_plan(named, "send me Contract.pdf please"))
    assert plan.exact_title == "Contract.pdf" and not plan.terms
    assert brain("send the Q3 board review.pdf").exact_title == "Q3 board review.pdf"
    assert brain('share "Mom passport.pdf"').exact_title == "Mom passport.pdf"
    checkpoint = {"request_exact_title": "Contract.pdf", "request_brain": named.as_checkpoint()}
    assert _trusted_subject_matches(checkpoint, {"name": "Contract.pdf"})
    assert not _trusted_subject_matches(checkpoint, {"name": "Smith NDA.pdf"})
    # Mixed with another subject, a file name stays an ordinary search.
    assert brain("invoices and Contract.pdf").exact_title is None
    assert brain_from_checkpoint(named.as_checkpoint()) == named


def test_month_and_quarter_names_outside_the_picked_dates_stay_in_the_subject():
    october = (date(2026, 10, 1), date(2026, 10, 17))
    june = brain("Project June roadmap", picked_period=october)
    assert "june" in {concept.canonical for concept in june.topics}
    assert _brain_title_evidence(june, "Project Jun roadmap v2.pdf")
    assert not _brain_title_evidence(june, "Project Falcon roadmap.pdf")
    deck = brain("Q3 board deck", picked_period=october)
    assert "q3" in {concept.canonical for concept in deck.topics}
    # Negative control: a month inside the picked dates is the period.
    september = brain(
        "statements for September", picked_period=(date(2026, 9, 1), date(2026, 9, 30))
    )
    assert "september" not in spellings(september)
    assert september.suggested_period == {"start": "2026-09-01", "end": "2026-09-30"}


def test_lowercase_mom_titles_are_never_meeting_notes_for_automatic_sharing():
    def candidate(text, name):
        checkpoint = {
            "authority_mode": "trusted_auto",
            "request_owner_review_required": False,
            "request_notes": True,
            "request_brain": brain(text).as_checkpoint(),
            "request": {"query": text},
        }
        return _note_candidate(checkpoint, {"name": name}, folder_scoped=False)

    for text in ("meeting notes", "send MoM of last week", "meeting recap", "minutes of meeting"):
        for name in ("Mom's Aadhaar.pdf", "Mom medical report.pdf", "Momentum strategy.docx"):
            assert not candidate(text, name), (text, name)
    # Positive control: the cased abbreviation, when the requester typed it.
    assert candidate("send MoM of last week", "MoM - Vendor review.pdf")
    assert candidate("minutes of meeting", "Q3 planning MOM.docx")
    assert not candidate("meeting notes", "MoM - Vendor review.pdf")


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
@pytest.mark.usefixtures("shared_hub_owner")
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
