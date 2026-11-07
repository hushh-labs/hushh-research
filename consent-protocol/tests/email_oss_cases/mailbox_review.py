"""Exact-ID selections attach to the existing Gmail action ledger."""

import json

import pytest

from hushh_mcp.services.gmail_receipts_service import GmailApiError
from tests.services.test_gmail_metadata_reader import _allowed, _mailbox, _ModifyGmail, _ProposalDb


async def test_selected_sdk_messages_use_existing_review_ledger_without_search_or_content_reads():
    from unittest.mock import AsyncMock

    gmail, db, requests = _ModifyGmail(), _ProposalDb(), []
    binding = ("owner", "gmail", "synthetic-account", "connected", "grant-revision")
    gmail.read_grant_binding = AsyncMock(return_value=binding)
    service = _mailbox(
        gmail,
        db,
        lambda request: (
            requests.append(request) or pytest.fail("No provider read before this exact-ID review")
        ),
    )
    pending = await service.propose_selected(
        user_id="owner",
        action="archive",
        message_ids=["m-1", "m-2"],
        label_id="",
        expected_account="synthetic-account",
        require_access=_allowed,
    )
    assert not requests
    assert db.rows[pending["proposal_id"]]["status"] == "pending"
    assert json.loads(db.rows[pending["proposal_id"]]["message_ids"]) == ["m-1", "m-2"]
    assert not db.executed_receipts
    with pytest.raises(GmailApiError, match="connection changed"):
        await service.propose_selected(
            user_id="owner",
            action="trash",
            message_ids=["m-1"],
            label_id="",
            expected_account="foreign-account",
            require_access=_allowed,
        )
    assert len(db.rows) == 1
