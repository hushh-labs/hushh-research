"""Tests for input bounds on stream analyze request models (CWE-400).

POST /kai/analyze/stream and POST /kai/analyze/run/start accept
StreamAnalyzeRequest and StartAnalyzeRunRequest respectively, then forward
the caller-supplied ticker and user_id into LLM inference and audit-log writes.

Before this fix neither model declared max_length on any string field.
The file already defined module-level constants (_USER_ID_MAX_LEN,
_TICKER_RAW_MAX_LEN, etc.) that were correctly applied to GET Query parameters
but were not applied to the POST body models, leaving an inconsistency:
a caller could send an oversized body while the same values would be rejected
on the query-param versions of the same endpoints.

Fix: StreamAnalyzeRequest and StartAnalyzeRunRequest now declare Field bounds
that match the constants already present at the top of the module.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.kai.stream import (
    _DEBATE_SESSION_ID_MAX_LEN,
    _RISK_PROFILE_MAX_LEN,
    _RUN_ID_MAX_LEN,
    _TICKER_RAW_MAX_LEN,
    _USER_ID_MAX_LEN,
    StartAnalyzeRunRequest,
    StreamAnalyzeRequest,
)

# ---------------------------------------------------------------------------
# StreamAnalyzeRequest bounds
# ---------------------------------------------------------------------------


class TestStreamAnalyzeRequestBounds:
    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            StreamAnalyzeRequest(
                user_id="u" * (_USER_ID_MAX_LEN + 1),
                ticker="AAPL",
            )

    def test_oversized_ticker_rejected(self):
        with pytest.raises(ValidationError):
            StreamAnalyzeRequest(
                user_id="uid123",
                ticker="X" * (_TICKER_RAW_MAX_LEN + 1),
            )

    def test_oversized_risk_profile_rejected(self):
        with pytest.raises(ValidationError):
            StreamAnalyzeRequest(
                user_id="uid123",
                ticker="AAPL",
                risk_profile="r" * (_RISK_PROFILE_MAX_LEN + 1),
            )

    def test_oversized_run_id_rejected(self):
        with pytest.raises(ValidationError):
            StreamAnalyzeRequest(
                user_id="uid123",
                ticker="AAPL",
                run_id="r" * (_RUN_ID_MAX_LEN + 1),
            )

    def test_valid_request_accepted(self):
        req = StreamAnalyzeRequest(user_id="uid123", ticker="AAPL")
        assert req.ticker == "AAPL"
        assert req.risk_profile == "balanced"

    def test_bounds_match_module_constants(self):
        """Ensure the Field bounds reference the same module-level constants used
        by the Query parameters, so GET and POST paths are consistent."""
        from pydantic.fields import FieldInfo

        field: FieldInfo = StreamAnalyzeRequest.model_fields["user_id"]
        max_len_values = [
            c.max_length for c in field.metadata if hasattr(c, "max_length")
        ]
        assert max_len_values, "user_id must have a max_length constraint"
        assert _USER_ID_MAX_LEN in max_len_values, (
            f"user_id max_length should be {_USER_ID_MAX_LEN}; found {max_len_values}"
        )


# ---------------------------------------------------------------------------
# StartAnalyzeRunRequest bounds
# ---------------------------------------------------------------------------


class TestStartAnalyzeRunRequestBounds:
    def test_oversized_user_id_rejected(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(
                user_id="u" * (_USER_ID_MAX_LEN + 1),
                debate_session_id="sess123",
                ticker="AAPL",
            )

    def test_oversized_debate_session_id_rejected(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(
                user_id="uid123",
                debate_session_id="d" * (_DEBATE_SESSION_ID_MAX_LEN + 1),
                ticker="AAPL",
            )

    def test_oversized_ticker_rejected(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(
                user_id="uid123",
                debate_session_id="sess123",
                ticker="X" * (_TICKER_RAW_MAX_LEN + 1),
            )

    def test_oversized_risk_profile_rejected(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(
                user_id="uid123",
                debate_session_id="sess123",
                ticker="AAPL",
                risk_profile="r" * (_RISK_PROFILE_MAX_LEN + 1),
            )

    def test_oversized_pick_source_rejected(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(
                user_id="uid123",
                debate_session_id="sess123",
                ticker="AAPL",
                pick_source="p" * (_RUN_ID_MAX_LEN + 1),
            )

    def test_oversized_pick_source_label_rejected(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(
                user_id="uid123",
                debate_session_id="sess123",
                ticker="AAPL",
                pick_source_label="l" * 257,
            )

    def test_oversized_pick_source_kind_rejected(self):
        with pytest.raises(ValidationError):
            StartAnalyzeRunRequest(
                user_id="uid123",
                debate_session_id="sess123",
                ticker="AAPL",
                pick_source_kind="k" * 65,
            )

    def test_valid_request_accepted(self):
        req = StartAnalyzeRunRequest(
            user_id="uid123",
            debate_session_id="sess-abc",
            ticker="AAPL",
        )
        assert req.ticker == "AAPL"
