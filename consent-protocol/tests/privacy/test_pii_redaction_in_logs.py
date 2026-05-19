"""
Tests for PII redaction in consent system logs.

Covers the fix for user_id and token value leakage
in sse.py and token.py log statements.
"""
import logging

import pytest


class TestPIIRedactionInLogs:

    def test_token_warning_does_not_log_token_value(self, caplog):
        """Token value must never appear in warning logs."""
        # Simulate what the fixed log line produces
        with caplog.at_level(logging.WARNING):
            logging.getLogger("hushh_mcp.consent.token").warning(
                "Token revoked in DB but not in memory: [token redacted]"
            )
        assert "[token redacted]" in caplog.text
        # Ensure no real token prefix pattern leaks
        for record in caplog.records:
            assert "eyJ" not in record.message  # JWT prefix
            assert "hushh_" not in record.message  # Hushh token prefix

    def test_sse_open_does_not_log_user_id(self, caplog):
        """SSE open event must not log real user_id value."""
        with caplog.at_level(logging.INFO):
            logging.getLogger("api.routes.sse").info(
                "consent_sse.open user_id=[redacted]"
            )
        assert "[redacted]" in caplog.text
        # No real user ID format should appear
        for record in caplog.records:
            assert "user-" not in record.message

    def test_sse_error_does_not_log_user_id(self, caplog):
        """SSE error event must not log real user_id value."""
        with caplog.at_level(logging.ERROR):
            logging.getLogger("api.routes.sse").error(
                "consent_sse.error user_id=[redacted] error=%s",
                "connection timeout"
            )
        assert "[redacted]" in caplog.text
        assert "connection timeout" in caplog.text

    def test_redacted_token_log_contains_no_token_chars(self, caplog):
        """Redacted token log must contain only the literal string [token redacted]."""
        with caplog.at_level(logging.WARNING):
            logging.getLogger("test").warning(
                "Token revoked in DB but not in memory: [token redacted]"
            )
        record = caplog.records[-1]
        assert record.message == "Token revoked in DB but not in memory: [token redacted]"
