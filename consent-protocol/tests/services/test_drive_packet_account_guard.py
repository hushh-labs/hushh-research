"""Account evidence reaches the authored builder and independent checker intact.

Semantic refusals are authored outcomes, never host substitutions. Scripted
all-Ready failures are independently exercised by the adversarial deploy gate.
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


async def build(members, *, answer=None):
    interpreter = AsyncMock(return_value=answer or proposal(members))
    packet = await construct_packet(
        user_id="owner",
        key="example-bank-statements-2026",
        documents=members,
        complete=True,
        interpret=interpreter,
    )
    return packet, interpreter


async def check(members, mode="complete_compact_summary", *, answer=None):
    checker = AsyncMock(return_value=answer or verdict())
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
    members = mixed_accounts()
    authored = {**proposal(members), "state": "incomplete", "gaps": [ACCOUNTS]}
    packet, interpreter = await build(members, answer=authored)
    assert packet.state == "incomplete"
    assert packet.gaps == [ACCOUNTS]
    # Preserve the authored refusal and its wording; no host-selected replacement.
    assert interpreter.await_count == 1
    PacketProposal.model_validate(packet.model_dump())


async def test_members_naming_different_holders_cannot_build_ready():
    members = mixed_holders()
    authored = {**proposal(members), "state": "incomplete", "gaps": [HOLDERS]}
    packet, interpreter = await build(members, answer=authored)
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
    authored = {
        **verdict(),
        "state": "incomplete",
        "correct_subject_and_account": False,
        "issues": [ACCOUNTS],
    }
    result, checker = await check(mixed_accounts(), mode, answer=authored)
    assert result.model_dump() == authored
    assert result.state == "incomplete"
    assert result.correct_subject_and_account is False
    assert ACCOUNTS in result.issues
    assert checker.await_count == 1


async def test_checker_cannot_certify_members_naming_different_holders():
    authored = {
        **verdict(),
        "state": "incomplete",
        "correct_subject_and_account": False,
        "issues": [HOLDERS],
    }
    result, _ = await check(mixed_holders(), answer=authored)
    assert result.model_dump() == authored
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


async def test_authored_account_refusal_cannot_be_overruled_by_ready_checker():
    # A nonready authored proposal cannot be promoted by a faulty final checker.
    # The all-Ready pair has a separate independent adversarial gate proof.
    members = mixed_accounts()
    packet, _ = await build(
        members, answer={**proposal(members), "state": "incomplete", "gaps": [ACCOUNTS]}
    )
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


async def test_host_file_timestamps_stay_outside_builder_and_checker_context():
    import json

    members = [
        statement("first", account=None, holder=None),
        statement("second", account=None, holder=None, month=10),
    ]
    for item in members:
        item["created_time"] = "2026-09-14T09:00:00Z"
    proposed = proposal(members)
    builder = AsyncMock(return_value=proposed)
    built = await construct_packet(
        user_id="owner", key="records", documents=members, complete=True, interpret=builder
    )
    assert built == PacketProposal.model_validate(proposed)
    checker = AsyncMock(return_value=verdict())
    checked = await verify_packet(
        user_id="owner",
        packet=built.model_dump(),
        documents=[compact_evidence(item) for item in members],
        complete=True,
        batch_scope=scope("complete_compact_summary", members),
        interpret=checker,
    )
    assert checked.model_dump() == verdict()
    for provider, key in [(builder, "documents"), (checker, "document_facts")]:
        payload = json.loads(provider.await_args.kwargs["prompt"])
        assert len(payload[key]) == 2
        assert all("created_time" not in item for item in payload[key])
    assert all(compact_evidence(item)["created_time"] for item in members)
