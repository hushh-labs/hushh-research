"""One real model run for the receipt notice reasoning, on synthetic mail only.

Opt-in: ``RECEIPT_NOTICE_LIVE_MODEL=1`` with Vertex credentials that can call the
configured model (``agent_email_receipt_notice``). It sends no real mailbox data:
every email below is made up for this test. The assertions are behavioural (what
may and may not be shown), not exact wording, because a model chooses its words.

    RECEIPT_NOTICE_LIVE_MODEL=1 .venv/bin/python -m pytest \
        tests/test_gmail_receipt_notice_live_model.py -s -p no:cacheprovider
"""

from __future__ import annotations

import os
from typing import Any

import pytest

from hushh_mcp.services.gmail_receipt_notice_service import GmailReceiptNoticeService
from tests.test_gmail_receipt_notice import NETFLIX, NOW, gmail, netflix_history
from tests.test_gmail_receipt_notice_service import FakeLive, FakeSession

pytestmark = pytest.mark.skipif(
    os.getenv("RECEIPT_NOTICE_LIVE_MODEL") != "1",
    reason="set RECEIPT_NOTICE_LIVE_MODEL=1 (and Vertex credentials) to run the real model",
)

SWIGGY = "Swiggy <orders@swiggy.in>"
OWNER_TOKEN = "synthetic-owner-token"


async def ask(messages: list[dict[str, Any]], receipt_ids: list[str]) -> dict[str, Any]:
    session = FakeSession("owner@example.test", messages)
    service = GmailReceiptNoticeService(
        live=FakeLive(session), clock=lambda: NOW
    )  # real model runner
    result = await service.analyze(
        user_id="synthetic-owner",
        consent_token=OWNER_TOKEN,
        require_access=_allow,
        receipt_keys=[f"key:{session.account}:{i}" for i in receipt_ids],
        expected_account=session.account,
    )
    print("\n--- real model answer ---")
    for found in result["findings"]:
        print(found["kind"], found["strength"], "|", found["headline"], "|", found["reason"])
    if not result["findings"]:
        print("no finding:", result["none_reason"])
    return result


async def _allow() -> None:
    return None


def kinds(result: dict[str, Any]) -> list[str]:
    return [f["kind"] for f in result["findings"]]


async def test_an_explicit_inactivity_notice_is_questioned_and_attributed_to_the_provider():
    notice = gmail(
        "n4",
        "2026-11-10",
        NETFLIX,
        "We haven't seen you",
        "Hi Asha. You haven't watched anything on this account in 60 days. Your plan renews on 2 Dec.",
    )
    result = await ask([*netflix_history(), notice], ["n1", "n2", "n3"])
    inactive = [f for f in result["findings"] if f["kind"] == "inactive_plan"]
    assert inactive, "the explicit notice should justify a question"
    assert (
        inactive[0]["attribution"]["by"] == "Netflix"
        and inactive[0]["attribution"]["on"] == "2026-11-10"
    )
    assert any(e["role"] == "provider_notice" for e in inactive[0]["evidence"])


async def test_a_generic_win_back_promotion_never_claims_the_account_was_unused():
    promo = gmail(
        "n4",
        "2026-11-10",
        NETFLIX,
        "We miss you",
        "We miss you! Come back and enjoy 30 percent off your next month.",
    )
    result = await ask([*netflix_history(), promo], ["n1", "n2", "n3"])
    assert not [
        f for f in result["findings"] if f["kind"] == "inactive_plan" and f["strength"] == "clear"
    ]


async def test_a_confirmed_refund_is_not_raised_and_a_quiet_inbox_proves_nothing():
    promise = gmail(
        "r1",
        "2026-11-05",
        SWIGGY,
        "Your refund is on its way",
        "We will refund ₹250 within 5 business days.",
    )
    done = gmail(
        "r2",
        "2026-11-11",
        SWIGGY,
        "Refund processed",
        "We refunded ₹250 to your original payment method.",
    )
    result = await ask([promise, done, *netflix_history()], ["n1", "n2", "n3", "r1"])
    assert "refund_followup" not in kinds(result)
    assert "inactive_plan" not in kinds(result)


async def test_a_cancellation_after_the_notice_removes_the_question():
    notice = gmail(
        "n4",
        "2026-11-10",
        NETFLIX,
        "We haven't seen you",
        "You haven't watched anything on this account in 60 days.",
    )
    ended = gmail(
        "n5",
        "2026-11-12",
        NETFLIX,
        "Your subscription has ended",
        "Your plan has ended. Sorry to see you go.",
    )
    result = await ask([*netflix_history(), notice, ended], ["n1", "n2", "n3"])
    assert "inactive_plan" not in kinds(result)
