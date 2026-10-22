"""Ready cannot rest on the model checker when the sources disagree about the account.

The extracted facts already carry each member's account identifier and record
owner. When selected members name different ones, the runtime closes the packet
as Incomplete with a plain reason instead of guessing which member is wrong.
All documents below are synthetic.
"""

from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_packet_contract import PacketProposal
from hushh_mcp.services.drive_packet_intelligence import (
    EvidenceValidationError,
    construct_packet,
    verify_packet,
)
from hushh_mcp.services.drive_packet_worker import compact_evidence

ACCOUNTS = "Documents name different accounts"
HOLDERS = "Documents name different account holders"


def cited(value):
    return {"value": value, "citations": [{"page": 1, "quote": value}]}


def statement(document_id, *, account, holder="Jane Example", month=9, kind="Monthly statement"):
    window = f"2026-{month:02d}-01", f"2026-{month:02d}-28"
    return {
        "document_id": document_id,
        "source_version": "1",
        "complete": True,
        "facts": {
            "document_type": cited(kind),
            "issuer": cited("Example Bank"),
            "subject": cited(holder) if holder else None,
            "account": cited(account) if account else None,
            "record_status": {
                "status": "unknown",
                "evidence_basis": "unknown",
                "explanation": "Record status was not assessed.",
                "citations": [],
            },
            "periods": [
                {
                    "start": window[0],
                    "end": window[1],
                    "citations": [{"page": 1, "quote": f"Statement period {month:02d}/2026"}],
                }
            ],
            "date_evidence": [],
            "topics": [],
            "facts": [cited("Ending balance $1,000.00")],
            "missing_information": [],
            "ambiguous": False,
        },
    }


def proposal(members):
    return {
        "title": "Example Bank statements",
        "description": "Monthly statements for one account.",
        "state": "ready",
        "selected_document_ids": [item["document_id"] for item in members],
        "excluded_documents": [],
        "coverage_summary": "September and October 2026.",
        "periods": [period for item in members for period in item["facts"]["periods"]],
        "temporal_scope": "document_period",
        "gaps": [],
        "assessment_score": 90,
        "importance": 50,
        "standalone_value": "supported",
        "utility_rationale": "Complete monthly statements.",
        "pricing": {
            "rubric_version": "drive-packet-price-v1",
            "useful_scope": "multi_period",
            "coverage": "complete",
            "quality": "verified",
            "rationale": "Two verified statement periods.",
            "suggested_price_cents": 500,
        },
    }


def verdict():
    return {
        "state": "ready",
        "correct_subject_and_account": True,
        "correct_issuer_and_type": True,
        "correct_record_status": True,
        "correct_standalone_value": True,
        "correct_coverage": True,
        "no_unrelated_inclusions": True,
        "no_unexplained_omissions": True,
        "issues": [],
    }


def scope(mode, members):
    return {
        "mode": mode,
        "member_count": len(members),
        "batch_checks_passed": True,
        "batch_issues": [],
        "canonical_key": "example-bank-statements-2026",
    }


async def build(members):
    interpreter = AsyncMock(return_value=proposal(members))
    packet = await construct_packet(
        user_id="owner",
        key="example-bank-statements-2026",
        documents=members,
        complete=True,
        interpret=interpreter,
    )
    return packet, interpreter


async def check(members, mode="complete_compact_summary"):
    checker = AsyncMock(return_value=verdict())
    result = await verify_packet(
        user_id="owner",
        packet=proposal(members),
        documents=[compact_evidence(item) for item in members],
        complete=True,
        batch_scope=scope(mode, members),
        interpret=checker,
    )
    return result, checker


def mixed_accounts():
    return [
        statement("sep", account="Account ending 1122"),
        statement("oct", account="Account ending 9876", month=10),
    ]


def mixed_holders():
    return [
        statement("sep", account="Account ending 1122"),
        statement("oct", account="Account ending 1122", holder="John Example", month=10),
    ]


async def test_members_naming_different_accounts_cannot_build_ready():
    packet, interpreter = await build(mixed_accounts())
    assert packet.state == "incomplete"
    assert packet.gaps == [ACCOUNTS]
    # The host decides from extracted facts; the model is not asked to guess again.
    assert interpreter.await_count == 1
    PacketProposal.model_validate(packet.model_dump())


async def test_members_naming_different_holders_cannot_build_ready():
    packet, interpreter = await build(mixed_holders())
    assert packet.state == "incomplete"
    assert packet.gaps == [HOLDERS]
    assert interpreter.await_count == 1


@pytest.mark.parametrize(
    "members",
    [
        # One account under two masks and two name spellings.
        [
            statement("sep", account="Account ending 1122", holder="JANE EXAMPLE"),
            statement("oct", account="XXXX-XXXX-1122", holder="Jane Example", month=10),
        ],
        # One member names the account; the other left it unknown.
        [
            statement("sep", account="Account ending 1122"),
            statement("oct", account=None, month=10),
        ],
        # Not account records: distinct subjects are topics, not holders.
        [
            statement("first", account=None, holder="Planning notes", kind="Meeting notes"),
            statement(
                "second", account=None, holder="Hiring notes", kind="Meeting notes", month=10
            ),
        ],
        # A joint account: one statement lists both holders, the other one of them.
        [
            statement("sep", account="Account ending 1122", holder="Jane Example"),
            statement(
                "oct",
                account="Account ending 1122",
                holder="Jane Example and John Example",
                month=10,
            ),
            statement("nov", account="Account ending 1122", holder="JOHN EXAMPLE", month=11),
        ],
        # A middle initial on one statement, and a cover letter naming both holders.
        [
            statement("sep", account="Account ending 1122", holder="Jane Q. Example"),
            statement("oct", account="Account ending 1122", holder="Jane Example", month=10),
            statement("letter", account=None, holder="Jane and John Example", kind="Letter"),
        ],
    ],
    ids=[
        "same_account_two_masks",
        "one_unknown_account",
        "notes_without_accounts",
        "joint_holders_listed_once",
        "middle_initial_and_joint_letter",
    ],
)
async def test_consistent_or_unknown_accounts_stay_ready(members):
    packet, _ = await build(members)
    assert packet.state == "ready" and packet.gaps == []


@pytest.mark.parametrize("mode", ["complete_compact_summary", "member_batch"])
async def test_checker_cannot_certify_members_naming_different_accounts(mode):
    result, checker = await check(mixed_accounts(), mode)
    assert result.state == "incomplete"
    assert result.correct_subject_and_account is False
    assert ACCOUNTS in result.issues
    assert checker.await_count == 1


async def test_checker_cannot_certify_members_naming_different_holders():
    result, _ = await check(mixed_holders())
    assert result.state == "incomplete"
    assert HOLDERS in result.issues


async def test_checker_keeps_one_account_ready():
    result, _ = await check(
        [
            statement("sep", account="Account ending 1122"),
            statement("oct", account="ending in 1122", month=10),
        ]
    )
    assert result.state == "ready" and result.issues == []


async def test_wrong_account_member_never_ends_ready():
    # Mirrors the eval guard case: a builder and a checker that both say Ready
    # over another account's statement. Finalize needs both answers Ready.
    members = mixed_accounts()
    packet, _ = await build(members)
    assert packet.state != "ready"
    with pytest.raises(EvidenceValidationError, match="model_readiness_invalid"):
        await verify_packet(
            user_id="owner",
            packet=packet.model_dump(mode="json"),
            documents=[compact_evidence(item) for item in members],
            complete=True,
            batch_scope=scope("complete_compact_summary", members),
            interpret=AsyncMock(return_value=verdict()),
        )


# Two originals of one statement that are not byte copies: same issuer, type,
# account and period, but different files and wording. The real-Drive eval
# found such a pair Ready as two members (two undated files of one document,
# created the same day). The exact same-content guard cannot see them.

SAME_STATEMENT = "Two documents look like the same statement"


def reprint(document_id="sep-reprint", *, account="XXXX-XXXX-1122"):
    """Another original of the September statement: a different mask, spelling
    and extracted fact, as a re-download or reprint has."""
    member = statement(document_id, account=account, holder="JANE EXAMPLE")
    member["facts"]["facts"] = [cited("Closing balance $1,000.00")]
    return member


async def test_two_originals_of_one_statement_cannot_build_ready():
    members = [statement("sep", account="Account ending 1122"), reprint()]
    packet, interpreter = await build(members)
    assert packet.state == "incomplete"
    assert packet.gaps == [SAME_STATEMENT]
    assert interpreter.await_count == 1
    PacketProposal.model_validate(packet.model_dump())

    # Keeping one and excluding the other as its duplicate is Ready.
    kept = proposal(members[:1])
    kept["excluded_documents"] = [
        {
            "document_id": "sep-reprint",
            "reason": "duplicate",
            "explanation": "A second original of the same September statement",
            "duplicate_of_document_id": "sep",
        }
    ]
    answer = await construct_packet(
        user_id="owner",
        key="example-bank-statements-2026",
        documents=members,
        complete=True,
        interpret=AsyncMock(return_value=kept),
    )
    assert answer.state == "ready" and answer.selected_document_ids == ["sep"]


@pytest.mark.parametrize(
    ("members", "gaps"),
    [
        # Two accounts at the same bank for the same month: the reason names the
        # accounts, not a duplicate.
        (
            [
                statement("checking", account="Account ending 1122"),
                statement("savings", account="Account ending 9876"),
            ],
            [ACCOUNTS],
        ),
        # A reprint that lost its account line is still the same statement.
        (
            [statement("sep", account="Account ending 1122"), reprint(account=None)],
            [SAME_STATEMENT],
        ),
        # Same bank and month, different document types.
        (
            [
                statement("sep", account="Account ending 1122"),
                statement("notice", account="Account ending 1122", kind="Rate change notice"),
            ],
            [],
        ),
    ],
    ids=["two_accounts_same_bank", "reprint_without_account", "different_types"],
)
async def test_same_statement_needs_the_same_issuer_type_account_and_period(members, gaps):
    packet, _ = await build(members)
    assert packet.gaps == gaps
    assert packet.state == ("ready" if not gaps else "incomplete")


def manual(document_id, *, created=None, kind="Product manual", published=None):
    member = statement(document_id, account=None, holder=None, kind=kind)
    facts = member["facts"]
    facts["issuer"] = cited("Example Labs")
    facts["periods"] = []
    facts["facts"] = [cited(f"Manual section {document_id}")]
    if published:
        facts["date_evidence"] = [
            {
                "role": "publication",
                "start": published,
                "end": published,
                "meaning": "Synthetic publication date",
                "citations": [{"page": 1, "quote": f"Published {published}"}],
            }
        ]
    if created:
        member["created_time"] = created
    return member


def manuals_proposal(members):
    result = proposal(members)
    result.update(
        title="Example Labs product manuals",
        description="Product manuals from one issuer.",
        coverage_summary="Product manuals; no reporting period is claimed.",
        periods=[],
        temporal_scope="no_period_claim",
        utility_rationale="Manuals an operator can use directly.",
    )
    result["pricing"]["useful_scope"] = "collection"
    return result


@pytest.mark.parametrize(
    ("members", "same"),
    [
        # Two versions of one manual created minutes apart, with no date of their own.
        (
            [
                manual("v1", created="2026-09-14T09:00:00Z"),
                manual("v2", created="2026-09-14T09:03:00Z"),
            ],
            True,
        ),
        (
            [
                manual("v1", created="2026-09-14T09:00:00Z"),
                manual("v2", created="2026-09-29T16:00:00Z"),
            ],
            False,
        ),
        # Without a creation time nothing tells two undated manuals apart from two
        # distinct ones, so they stay with the model checker.
        ([manual("v1"), manual("v2")], False),
        # The documents' own dates decide before any file time does.
        (
            [
                manual("release-a", published="2026-09-08", created="2026-09-14T11:00:00Z"),
                manual("release-b", published="2026-09-08", created="2026-09-18T11:00:00Z"),
            ],
            True,
        ),
        (
            [
                manual("release-a", published="2026-09-08", created="2026-09-14T11:00:00Z"),
                manual("release-b", published="2026-09-22", created="2026-09-14T11:00:00Z"),
            ],
            False,
        ),
    ],
    ids=[
        "undated_same_day",
        "undated_other_day",
        "undated_no_file_time",
        "same_publication_date",
        "other_publication_date",
    ],
)
async def test_undated_or_dated_documents_of_one_record_cannot_build_ready(members, same):
    interpreter = AsyncMock(return_value=manuals_proposal(members))
    packet = await construct_packet(
        user_id="owner",
        key="example-labs-manuals",
        documents=members,
        complete=True,
        interpret=interpreter,
    )
    assert packet.gaps == ([SAME_STATEMENT] if same else [])
    assert packet.state == ("incomplete" if same else "ready")
    # A file's creation time decides nothing the model is shown.
    prompt = interpreter.await_args.kwargs["prompt"]
    assert "created_time" not in prompt and "2026-09-14T" not in prompt


@pytest.mark.parametrize("mode", ["complete_compact_summary", "member_batch"])
async def test_checker_cannot_certify_two_originals_of_one_statement(mode):
    members = [statement("sep", account="Account ending 1122"), reprint()]
    result, checker = await check(members, mode)
    assert result.state == "incomplete"
    assert result.correct_coverage is False
    assert SAME_STATEMENT in result.issues
    assert checker.await_count == 1


async def test_final_checker_reads_the_file_time_but_never_shows_it():
    members = [
        manual("v1", created="2026-09-14T09:00:00Z"),
        manual("v2", created="2026-09-14T09:03:00Z"),
    ]
    documents = [compact_evidence(item) for item in members]
    assert [item["created_time"] for item in documents] == [
        "2026-09-14T09:00:00Z",
        "2026-09-14T09:03:00Z",
    ]
    checker = AsyncMock(return_value=verdict())
    result = await verify_packet(
        user_id="owner",
        packet=manuals_proposal(members),
        documents=documents,
        complete=True,
        batch_scope=scope("complete_compact_summary", members),
        interpret=checker,
    )
    assert result.state == "incomplete" and SAME_STATEMENT in result.issues
    prompt = checker.await_args.kwargs["prompt"]
    assert "created_time" not in prompt and "2026-09-14T" not in prompt


def claim_record(document_id, *, service, amount, wording="Amount billed"):
    """One claim's record from an insurer that issues several on one day."""
    member = statement(document_id, account="Member ID XXXX4321", holder=None)
    facts = member["facts"]
    facts["document_type"] = cited("Explanation of benefits")
    facts["issuer"] = cited("Example Health Plan")
    facts["periods"] = []
    facts["facts"] = [cited(f"{wording} {amount}")]
    facts["date_evidence"] = [
        {
            "role": role,
            "start": day,
            "end": day,
            "meaning": f"Synthetic {role} date",
            "citations": [{"page": 1, "quote": f"{role} {day}"}],
        }
        for role, day in (("publication", "2026-09-08"), ("event", service))
    ]
    return member


@pytest.mark.parametrize(
    ("members", "same"),
    [
        # Two claims processed on one day: different service dates and totals.
        (
            [
                claim_record("claim-a", service="2026-08-10", amount="$240.00"),
                claim_record("claim-b", service="2026-08-22", amount="$95.00"),
            ],
            False,
        ),
        # Two visits on one day, told apart by their totals.
        (
            [
                claim_record("claim-a", service="2026-08-10", amount="$240.00"),
                claim_record("claim-b", service="2026-08-10", amount="$95.00"),
            ],
            False,
        ),
        # Two originals of one claim's record agree on what they date and total.
        (
            [
                claim_record("claim-a", service="2026-08-10", amount="$240.00"),
                claim_record(
                    "claim-a-copy", service="2026-08-10", amount="$240.00", wording="Billed:"
                ),
            ],
            True,
        ),
    ],
    ids=["two_claims", "two_visits_one_day", "two_originals"],
)
async def test_records_issued_on_one_day_are_one_record_only_when_they_agree(members, same):
    result = manuals_proposal(members)
    result.update(
        title="Example Health Plan claim records",
        description="Claim records from one insurer.",
        coverage_summary="Claim records; no reporting period is claimed.",
    )
    packet = await construct_packet(
        user_id="owner",
        key="example-health-claims",
        documents=members,
        complete=True,
        interpret=AsyncMock(return_value=result),
    )
    assert packet.gaps == ([SAME_STATEMENT] if same else [])
    assert packet.state == ("incomplete" if same else "ready")
