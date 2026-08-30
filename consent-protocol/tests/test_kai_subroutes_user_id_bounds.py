"""
Tests for user_id field bounds on Kai support request models.

SupportMessageRequest feeds user_id into the email delivery queue.
Without a max_length constraint any caller can submit an arbitrarily long
identifier, causing oversized database writes and unbounded log payloads
(CWE-400).

These tests confirm that Pydantic rejects oversized inputs before they
reach the handler.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.kai.support import SupportMessageRequest

_USER_ID_MAX = 128
# ---------------------------------------------------------------------------
# SupportMessageRequest -- user_id
# ---------------------------------------------------------------------------


def test_support_user_id_at_max_accepted():
    req = SupportMessageRequest(
        user_id="u" * _USER_ID_MAX,
        kind="support_request",
        subject="Need help",
        message="Please help me with my account.",
    )
    assert len(req.user_id) == _USER_ID_MAX


def test_support_user_id_over_max_rejected():
    with pytest.raises(ValidationError):
        SupportMessageRequest(
            user_id="u" * (_USER_ID_MAX + 1),
            kind="support_request",
            subject="Need help",
            message="Please help me with my account.",
        )


def test_support_user_id_empty_rejected():
    with pytest.raises(ValidationError):
        SupportMessageRequest(
            user_id="",
            kind="bug_report",
            subject="Found a bug",
            message="The app crashes on startup every time.",
        )


def test_support_user_id_typical_accepted():
    req = SupportMessageRequest(
        user_id="user_abc123",
        kind="bug_report",
        subject="App crashes",
        message="Reproducible crash on the portfolio screen.",
    )
    assert req.user_id == "user_abc123"
