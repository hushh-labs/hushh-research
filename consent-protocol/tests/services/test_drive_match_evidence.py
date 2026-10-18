"""D3: only title evidence of typed words shares itself; everything else waits for the owner."""

from datetime import UTC, date, datetime

import pytest

from hushh_mcp.services.drive_match_evidence import (
    CONTENT,
    CORRECTED,
    EVIDENCE_KIND_FIELD,
    OWNER_SENT_FIELD,
    POSSIBLE_KINDS,
    SYNONYM,
    TITLE,
    WALK,
    automatic_claims,
    awaiting_owner,
    is_possible_match,
    owner_sent,
    owner_sent_fields,
    possible_kind,
    possible_match_fields,
    tagged_possible,
    title_evidence_fields,
    title_gate,
)
from hushh_mcp.services.drive_request_brain import interpret_request
from hushh_mcp.services.drive_request_review_policy import AUTOSHARE_SELECTION_POLICY

NOW = datetime(2026, 10, 17, 9, 0, tzinfo=UTC)
PERIOD = (date(2026, 7, 17), date(2026, 10, 17))


def _checkpoint(text, *, vocabulary=None, **patch):
    brain = interpret_request(text, now=NOW, vocabulary=vocabulary, picked_period=PERIOD)
    return {
        "authority_mode": "trusted_auto",
        "agent_package_required": False,
        "request_owner_review_required": False,
        "request_selection_policy": AUTOSHARE_SELECTION_POLICY,
        "requested_period": {"start": PERIOD[0].isoformat(), "end": PERIOD[1].isoformat()},
        "request_brain": brain.as_checkpoint(),
        "request": {"query": text},
        "request_notes": "notes" in text.casefold(),
        **patch,
    }


def _file(name, **patch):
    return {"id": f"id-{abs(hash(name))}", "name": name, "shareable": True, **patch}


# B asked for Sneha's salary slip; the owner's Drive has only "neha", so the
# brain corrects sneha -> neha for discovery. That correction is never evidence.
SNEHA = _checkpoint("Sneha salary slip", vocabulary=["neha", "salary", "slip"])


def test_gear_tags_are_a_closed_set_and_title_is_never_a_possible_kind():
    assert POSSIBLE_KINDS == {CONTENT, CORRECTED, SYNONYM, WALK}
    for kind in POSSIBLE_KINDS:
        assert possible_match_fields(kind) == {EVIDENCE_KIND_FIELD: kind}
    for bad in (TITLE, "fuzzy", "", None, 3):
        with pytest.raises(ValueError):
            possible_match_fields(bad)
    assert title_evidence_fields() == {EVIDENCE_KIND_FIELD: TITLE}


def test_missing_or_title_tag_is_title_evidence_and_anything_else_fails_closed():
    assert tagged_possible({}) is False
    assert tagged_possible({EVIDENCE_KIND_FIELD: TITLE}) is False
    for value in (*POSSIBLE_KINDS, "Title", "unknown", "", None, 1, ["title"], {"kind": "title"}):
        assert tagged_possible({EVIDENCE_KIND_FIELD: value}) is True, value
    # The owner is shown a plain reason even for a malformed tag.
    assert possible_kind({EVIDENCE_KIND_FIELD: WALK}) == WALK
    assert possible_kind({EVIDENCE_KIND_FIELD: "garbage"}) == CONTENT
    assert possible_kind({}) == CONTENT


def test_corrected_spelling_is_discovery_only_sneha_is_not_neha():
    assert title_gate(SNEHA, _file("Sneha salary slip Aug.pdf")) is True
    assert title_gate(SNEHA, _file("Payslip Sneha Aug.pdf")) is True  # exact synonym
    # Negative control for the line above: the corrected name never shares itself.
    neha = _file("Neha salary slip Aug.pdf")
    assert title_gate(SNEHA, neha) is False
    assert awaiting_owner(SNEHA, neha) is True
    assert is_possible_match(SNEHA, neha) is True
    assert awaiting_owner(SNEHA, _file("Sneha salary slip Aug.pdf")) is False


@pytest.mark.parametrize(
    "text,title,near_miss",
    [
        ("Rental agreement", "Rental agreement 2026.pdf", "Dental agreement 2026.pdf"),
        ("Contract renewal", "Contract renewal Sep.pdf", "Contacts renewal Sep.pdf"),
        ("HDFC bank statement", "HDFC bank statement Sep.pdf", "ICICI bank statement Sep.pdf"),
    ],
)
def test_near_miss_titles_wait_for_the_owner(text, title, near_miss):
    checkpoint = _checkpoint(text, vocabulary=["dental", "contacts", "icici"])
    assert awaiting_owner(checkpoint, _file(title)) is False
    assert awaiting_owner(checkpoint, _file(near_miss)) is True


def test_a_gear_tag_wins_even_over_a_matching_title():
    # A content gear that tags its hit as content asked for owner review.
    tagged = _file("Sneha salary slip Aug.pdf", **possible_match_fields(CONTENT))
    assert title_gate(SNEHA, tagged) is True
    assert awaiting_owner(SNEHA, tagged) is True
    # Explicit title evidence is claimable like an untagged title match.
    assert awaiting_owner(SNEHA, {**tagged, **title_evidence_fields()}) is False


def test_an_untagged_result_without_title_evidence_still_waits():
    # Backstop: a gear forgot to tag its content-only hit.
    assert awaiting_owner(SNEHA, _file("Q3 payroll register.xlsx")) is True


def test_a_shortcut_alias_never_lends_title_evidence():
    # The target is what Drive grants; only its own title counts.
    alias = _file("Team offsite photos.zip", shortcutName="Sneha salary slip Aug")
    assert title_gate(SNEHA, alias) is False
    assert awaiting_owner(SNEHA, alias) is True


def test_the_owners_send_is_the_only_release():
    neha = _file("Neha salary slip Aug.pdf", **possible_match_fields(CORRECTED))
    assert owner_sent(neha) is False
    sent = {**neha, **owner_sent_fields()}
    assert owner_sent(sent) is True
    assert awaiting_owner(SNEHA, sent) is False
    # Still a possible match in the owner's list (shown as queued).
    assert is_possible_match(SNEHA, sent) is True
    # A forged or legacy marker is not a Send.
    for marker in (True, "yes", {"version": 2}, {"version": "1"}, None):
        assert owner_sent({**neha, OWNER_SENT_FIELD: marker}) is False
        assert awaiting_owner(SNEHA, {**neha, OWNER_SENT_FIELD: marker}) is True


def test_unshareable_files_are_never_listed_but_still_never_auto_claimed():
    blocked = _file("Neha salary slip Aug.pdf", shareable=False)
    assert is_possible_match(SNEHA, blocked) is False
    assert awaiting_owner(SNEHA, blocked) is True


@pytest.mark.parametrize(
    "patch",
    [
        {"authority_mode": "owner"},
        {"authority_mode": "agent_package"},
        {"agent_package_required": True},
        {"request_owner_review_required": True},
        {"request_owner_review_required": None},
    ],
)
def test_owner_reviewed_and_package_searches_are_never_reclassified(patch):
    checkpoint = {**SNEHA, **patch}
    assert automatic_claims(checkpoint) is False
    neha = _file("Neha salary slip Aug.pdf", **possible_match_fields(CONTENT))
    assert awaiting_owner(checkpoint, neha) is False
    assert is_possible_match(checkpoint, neha) is False
    # Negative control: the same file under the automatic checkpoint waits.
    assert awaiting_owner(SNEHA, neha) is True


def test_meeting_notes_title_rule_holds_at_claim_time():
    standup = _checkpoint("Standup notes from last 3 months")
    assert awaiting_owner(standup, _file("Standup notes 2026-09-01.pdf")) is False
    # A standup agenda mentions the topic but is not a note.
    assert awaiting_owner(standup, _file("Standup agenda 2026-09-01.pdf")) is True
    assert awaiting_owner(standup, _file("Weekly sync agenda.pdf")) is True


def test_legacy_checkpoint_without_a_brain_keeps_its_subject_terms():
    legacy = {
        "authority_mode": "trusted_auto",
        "request_owner_review_required": False,
        "request_subject_terms": ["invoice"],
        "request": {"query": "Invoices from September"},
    }
    assert awaiting_owner(legacy, _file("Invoice 2026-09 HDFC.pdf")) is False
    assert awaiting_owner(legacy, _file("Receipt 2026-09 HDFC.pdf")) is True


def test_missing_or_malformed_names_fail_closed():
    for name in (None, "", 7):
        assert title_gate(SNEHA, {"name": name, "shareable": True}) is False
        assert awaiting_owner(SNEHA, {"name": name, "shareable": True}) is True
