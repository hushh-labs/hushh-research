# tests/test_schemas_input_bounds.py
"""
Regression tests for input bounds on api/models/schemas.py request models.

Every public-facing request model must reject oversized inputs so that the
application layer never has to defend against multi-megabyte strings being
processed by downstream services or stored in the database.

These tests prove the Pydantic validators are present and active for all
fields added in this changeset.
"""

import pytest
from pydantic import ValidationError

from api.models.schemas import (
    ChatRequest,
    ConsentRequest,
    DataAccessRequest,
    HistoryRequest,
    LogoutRequest,
    SessionTokenRequest,
    ValidateTokenRequest,
)


# ---------------------------------------------------------------------------
# ChatRequest
# ---------------------------------------------------------------------------


class TestChatRequestBounds:
    def test_valid_request_accepted(self):
        req = ChatRequest(userId="uid123", message="Hello")
        assert req.userId == "uid123"
        assert req.message == "Hello"

    def test_empty_user_id_rejected(self):
        with pytest.raises(ValidationError):
            ChatRequest(userId="", message="Hello")

    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            ChatRequest(userId="x" * 129, message="Hello")

    def test_empty_message_rejected(self):
        with pytest.raises(ValidationError):
            ChatRequest(userId="uid123", message="")

    def test_oversized_message_rejected(self):
        with pytest.raises(ValidationError):
            ChatRequest(userId="uid123", message="x" * 8193)

    def test_max_length_boundary_accepted(self):
        req = ChatRequest(userId="x" * 128, message="x" * 8192)
        assert len(req.userId) == 128
        assert len(req.message) == 8192


# ---------------------------------------------------------------------------
# ValidateTokenRequest
# ---------------------------------------------------------------------------


class TestValidateTokenRequestBounds:
    def test_valid_token_accepted(self):
        req = ValidateTokenRequest(token="tok_abc123")
        assert req.token == "tok_abc123"

    def test_empty_token_rejected(self):
        with pytest.raises(ValidationError):
            ValidateTokenRequest(token="")

    def test_oversized_token_rejected(self):
        with pytest.raises(ValidationError):
            ValidateTokenRequest(token="x" * 2049)

    def test_max_length_boundary_accepted(self):
        req = ValidateTokenRequest(token="x" * 2048)
        assert len(req.token) == 2048


# ---------------------------------------------------------------------------
# ConsentRequest
# ---------------------------------------------------------------------------


class TestConsentRequestBounds:
    def _valid(self, **overrides):
        base = {
            "user_id": "uid123",
            "developer_token": "devtok_abc",
            "scope": "attr.food.*",
        }
        base.update(overrides)
        return ConsentRequest(**base)

    def test_valid_request_accepted(self):
        req = self._valid()
        assert req.user_id == "uid123"

    def test_empty_user_id_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(user_id="")

    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(user_id="x" * 129)

    def test_empty_developer_token_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(developer_token="")

    def test_oversized_developer_token_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(developer_token="x" * 513)

    def test_oversized_scope_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(scope="x" * 257)

    def test_oversized_reason_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(reason="x" * 1025)

    def test_expiry_hours_below_minimum_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(expiry_hours=0)

    def test_expiry_hours_above_maximum_rejected(self):
        with pytest.raises(ValidationError):
            self._valid(expiry_hours=721)

    def test_expiry_hours_boundaries_accepted(self):
        assert self._valid(expiry_hours=1).expiry_hours == 1
        assert self._valid(expiry_hours=720).expiry_hours == 720


# ---------------------------------------------------------------------------
# DataAccessRequest
# ---------------------------------------------------------------------------


class TestDataAccessRequestBounds:
    def test_valid_request_accepted(self):
        req = DataAccessRequest(user_id="uid123", consent_token="tok_abc")
        assert req.user_id == "uid123"

    def test_empty_user_id_rejected(self):
        with pytest.raises(ValidationError):
            DataAccessRequest(user_id="", consent_token="tok_abc")

    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            DataAccessRequest(user_id="x" * 129, consent_token="tok_abc")

    def test_empty_consent_token_rejected(self):
        with pytest.raises(ValidationError):
            DataAccessRequest(user_id="uid123", consent_token="")

    def test_oversized_consent_token_rejected(self):
        with pytest.raises(ValidationError):
            DataAccessRequest(user_id="uid123", consent_token="x" * 2049)


# ---------------------------------------------------------------------------
# LogoutRequest
# ---------------------------------------------------------------------------


class TestLogoutRequestBounds:
    def test_valid_request_accepted(self):
        req = LogoutRequest(userId="uid123")
        assert req.userId == "uid123"

    def test_empty_user_id_rejected(self):
        with pytest.raises(ValidationError):
            LogoutRequest(userId="")

    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            LogoutRequest(userId="x" * 129)


# ---------------------------------------------------------------------------
# HistoryRequest
# ---------------------------------------------------------------------------


class TestHistoryRequestBounds:
    def test_valid_request_accepted(self):
        req = HistoryRequest(userId="uid123")
        assert req.page == 1
        assert req.limit == 20

    def test_empty_user_id_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="")

    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="x" * 129)

    def test_page_below_minimum_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="uid123", page=0)

    def test_page_above_maximum_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="uid123", page=10_001)

    def test_limit_below_minimum_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="uid123", limit=0)

    def test_limit_above_maximum_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="uid123", limit=201)


# ---------------------------------------------------------------------------
# SessionTokenRequest
# ---------------------------------------------------------------------------


class TestSessionTokenRequestBounds:
    def test_valid_request_accepted(self):
        req = SessionTokenRequest(userId="uid123")
        assert req.scope == "session"

    def test_empty_user_id_rejected(self):
        with pytest.raises(ValidationError):
            SessionTokenRequest(userId="")

    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            SessionTokenRequest(userId="x" * 129)
