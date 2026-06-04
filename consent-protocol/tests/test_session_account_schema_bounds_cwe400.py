"""CWE-400 bounds tests for authentication/session request schemas.

Covers request models only (api/models/schemas.py):
  - ChatRequest.userId          max_length=128
  - ChatRequest.message         max_length=8192
  - ValidateTokenRequest.token  max_length=2048
  - ConsentRequest.user_id      max_length=128
  - ConsentRequest.developer_token max_length=512
  - ConsentRequest.scope        max_length=256
  - ConsentRequest.reason       max_length=1024
  - ConsentRequest.expiry_hours ge=1 le=720
  - DataAccessRequest.user_id   max_length=128
  - DataAccessRequest.consent_token max_length=2048
  - SessionTokenRequest.userId  max_length=128
  - SessionTokenRequest.scope   max_length=64
  - LogoutRequest.userId        max_length=128
  - HistoryRequest.userId       max_length=128
  - HistoryRequest.page         ge=1 le=10000
  - HistoryRequest.limit        ge=1 le=200
"""

from __future__ import annotations

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


class TestChatRequestBounds:
    def test_valid(self):
        req = ChatRequest(userId="u1", message="hello")
        assert req.userId == "u1"

    def test_user_id_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            ChatRequest(userId="a" * 129, message="hello")

    def test_message_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            ChatRequest(userId="u1", message="a" * 8193)

    def test_user_id_empty_rejected(self):
        with pytest.raises(ValidationError):
            ChatRequest(userId="", message="hello")


class TestValidateTokenRequestBounds:
    def test_valid(self):
        req = ValidateTokenRequest(token="tok")  # noqa: S106
        assert req.token == "tok"  # noqa: S105

    def test_token_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            ValidateTokenRequest(token="a" * 2049)  # noqa: S106

    def test_token_empty_rejected(self):
        with pytest.raises(ValidationError):
            ValidateTokenRequest(token="")  # noqa: S106


class TestConsentRequestBounds:
    def test_valid(self):
        req = ConsentRequest(user_id="u1", developer_token="dev", scope="vault.read")  # noqa: S106
        assert req.expiry_hours == 24

    def test_user_id_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            ConsentRequest(user_id="a" * 129, developer_token="dev", scope="vault.read")  # noqa: S106

    def test_developer_token_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            ConsentRequest(user_id="u1", developer_token="a" * 513, scope="vault.read")  # noqa: S106

    def test_scope_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            ConsentRequest(user_id="u1", developer_token="dev", scope="a" * 257)  # noqa: S106

    def test_reason_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            ConsentRequest(
                user_id="u1",
                developer_token="dev",  # noqa: S106
                scope="vault.read",
                reason="a" * 1025,
            )

    def test_expiry_hours_below_min_rejected(self):
        with pytest.raises(ValidationError):
            ConsentRequest(user_id="u1", developer_token="dev", scope="vault.read", expiry_hours=0)  # noqa: S106

    def test_expiry_hours_above_max_rejected(self):
        with pytest.raises(ValidationError):
            ConsentRequest(user_id="u1", developer_token="dev", scope="vault.read", expiry_hours=721)  # noqa: S106


class TestDataAccessRequestBounds:
    def test_valid(self):
        req = DataAccessRequest(user_id="u1", consent_token="tok")  # noqa: S106
        assert req.user_id == "u1"

    def test_user_id_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            DataAccessRequest(user_id="a" * 129, consent_token="tok")  # noqa: S106

    def test_consent_token_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            DataAccessRequest(user_id="u1", consent_token="a" * 2049)  # noqa: S106


class TestSessionTokenRequestBounds:
    def test_valid(self):
        req = SessionTokenRequest(userId="u1")
        assert req.scope == "session"

    def test_user_id_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            SessionTokenRequest(userId="a" * 129)

    def test_scope_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            SessionTokenRequest(userId="u1", scope="a" * 65)


class TestLogoutRequestBounds:
    def test_valid(self):
        req = LogoutRequest(userId="u1")
        assert req.userId == "u1"

    def test_user_id_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            LogoutRequest(userId="a" * 129)


class TestHistoryRequestBounds:
    def test_valid(self):
        req = HistoryRequest(userId="u1")
        assert req.page == 1
        assert req.limit == 20

    def test_user_id_over_max_length_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="a" * 129)

    def test_page_below_min_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="u1", page=0)

    def test_page_above_max_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="u1", page=10001)

    def test_limit_below_min_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="u1", limit=0)

    def test_limit_above_max_rejected(self):
        with pytest.raises(ValidationError):
            HistoryRequest(userId="u1", limit=201)
