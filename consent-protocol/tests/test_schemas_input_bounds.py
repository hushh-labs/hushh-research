# tests/test_schemas_input_bounds.py
"""
Regression tests for input bounds on api/models/schemas.py request models.

Every public-facing request model must reject oversized inputs so that the
application layer never has to defend against multi-megabyte strings being
processed by downstream services or stored in the database.

These tests prove the Pydantic validators are present and active for all
fields added in this changeset.
"""

import json

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
        req = ValidateTokenRequest(token="tok_abc123")  # noqa: S106
        assert req.token == "tok_abc123"  # noqa: S105

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
        req = DataAccessRequest(user_id="uid123", consent_token="tok_abc")  # noqa: S106
        assert req.user_id == "uid123"

    def test_empty_user_id_rejected(self):
        with pytest.raises(ValidationError):
            DataAccessRequest(user_id="", consent_token="tok_abc")  # noqa: S106

    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            DataAccessRequest(user_id="x" * 129, consent_token="tok_abc")  # noqa: S106

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


# ---------------------------------------------------------------------------
# Duplicate key handling and JSON parsing isolation
#
# When a JSON payload contains duplicate keys (e.g. {"user_id":"a","user_id":"b"})
# Python's stdlib json.loads and Pydantic v2's model_validate_json both follow
# the last-value-wins convention from RFC 7159 § 4 (unspecified behaviour is
# left to the implementation; CPython and pydantic-core/jiter choose last-wins).
#
# Contracts under test:
#   1. model_validate_json never raises an unhandled exception on duplicate keys.
#   2. The resolved value is deterministic: the last occurrence wins.
#   3. stdlib json.loads exhibits the identical last-value-wins behaviour.
#   4. Strict duplicate detection is achievable via object_pairs_hook when the
#      caller requires it — showing the contract is deliberate, not a blind spot.
#   5. Invalid map structures (arrays, null, empty objects missing required
#      fields) always raise ValidationError, never an uncaught exception.
# ---------------------------------------------------------------------------


class TestSchemaJsonDuplicateKeyParsing:
    """Verify schema parsing contracts for duplicate keys and invalid map shapes."""

    # ── last-value-wins via model_validate_json ───────────────────────────────

    def test_consent_request_duplicate_user_id_last_value_wins(self):
        """Duplicate 'user_id' key: last occurrence wins, no unhandled exception."""
        json_dup = (
            '{"user_id": "first_user", "user_id": "second_user",'
            ' "developer_token": "dev_tok", "scope": "attr.food.*"}'
        )
        req = ConsentRequest.model_validate_json(json_dup)
        assert req.user_id == "second_user"
        assert req.developer_token == "dev_tok"

    def test_consent_request_duplicate_scope_last_value_wins(self):
        """Duplicate 'scope' key: last occurrence replaces earlier one."""
        json_dup = (
            '{"user_id": "uid123", "developer_token": "dev_tok",'
            ' "scope": "attr.food.*", "scope": "attr.financial.*"}'
        )
        req = ConsentRequest.model_validate_json(json_dup)
        assert req.scope == "attr.financial.*"

    def test_chat_request_duplicate_user_id_last_value_wins(self):
        """Duplicate 'userId' key in ChatRequest: last value is stored."""
        json_dup = (
            '{"userId": "first_uid", "userId": "second_uid",'
            ' "message": "hello"}'
        )
        req = ChatRequest.model_validate_json(json_dup)
        assert req.userId == "second_uid"
        assert req.message == "hello"

    def test_chat_request_nested_duplicate_key_in_session_state_last_value_wins(self):
        """Duplicate key inside sessionState (Optional[Dict[str,Any]]): last wins."""
        json_nested_dup = (
            '{"userId": "uid123", "message": "hello",'
            ' "sessionState": {"ctx_key": "first", "ctx_key": "second"}}'
        )
        req = ChatRequest.model_validate_json(json_nested_dup)
        assert req.sessionState == {"ctx_key": "second"}

    # ── stdlib json.loads behaviour documented ────────────────────────────────

    def test_stdlib_json_loads_duplicate_key_last_value_wins(self):
        """Python json.loads also uses last-value-wins for duplicate keys."""
        raw = '{"user_id": "first", "user_id": "second", "scope": "read"}'
        parsed = json.loads(raw)
        assert parsed["user_id"] == "second"
        # Only one entry for the key — no phantom first value remains.
        assert len([k for k in parsed if k == "user_id"]) == 1

    def test_stdlib_json_loads_multiple_duplicates_each_last_wins(self):
        """Multiple duplicate keys each resolve to their last occurrence."""
        raw = (
            '{"a": "a1", "b": "b1", "a": "a2", "b": "b2", "a": "a3"}'
        )
        parsed = json.loads(raw)
        assert parsed["a"] == "a3"
        assert parsed["b"] == "b2"

    # ── strict duplicate detection via object_pairs_hook ─────────────────────

    def test_object_pairs_hook_can_enforce_no_duplicate_keys(self):
        """Callers requiring strict uniqueness can detect duplicates via hook."""
        def _reject_duplicates(pairs: list) -> dict:
            seen: dict = {}
            for k, v in pairs:
                if k in seen:
                    raise ValueError(f"Duplicate key in JSON payload: {k!r}")
                seen[k] = v
            return seen

        # A well-formed payload passes the hook without error.
        clean = '{"user_id": "uid123", "developer_token": "tok", "scope": "read"}'
        parsed = json.loads(clean, object_pairs_hook=_reject_duplicates)
        assert parsed["user_id"] == "uid123"

        # A payload with duplicate keys raises ValueError via the hook.
        duplicate = '{"user_id": "first", "user_id": "second"}'
        with pytest.raises(ValueError, match="Duplicate key"):
            json.loads(duplicate, object_pairs_hook=_reject_duplicates)

    # ── invalid map structures raise ValidationError ──────────────────────────

    def test_empty_json_object_raises_validation_error_missing_required_fields(self):
        """An empty {} fails validation because required fields are absent."""
        with pytest.raises(ValidationError):
            ConsentRequest.model_validate_json("{}")
        with pytest.raises(ValidationError):
            ChatRequest.model_validate_json("{}")

    def test_json_array_top_level_raises_validation_error(self):
        """A top-level JSON array is rejected — schemas expect an object."""
        with pytest.raises(ValidationError):
            ConsentRequest.model_validate_json("[]")
        with pytest.raises(ValidationError):
            ChatRequest.model_validate_json('["uid123", "hello"]')

    def test_json_null_top_level_raises_validation_error(self):
        """A top-level JSON null is rejected by all models."""
        with pytest.raises(ValidationError):
            ConsentRequest.model_validate_json("null")
        with pytest.raises(ValidationError):
            ChatRequest.model_validate_json("null")
