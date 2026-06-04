"""
Tests for log redaction in OneLocationAgentService.
Verifies user_id is redacted via redact_log_value in all
notification and identity lookup log paths.
"""

import logging
from unittest.mock import MagicMock, patch

import pytest


class TestOneLocationLogRedaction:
    """user_id must never appear in plaintext in location service logs."""

    def test_notification_send_failed_redacts_user_id(self, caplog):
        """notification_send_failed must not log raw user_id."""
        from mcp_modules.log_redaction import redact_log_value
        user_id = "firebase-uid-abc123"
        redacted = redact_log_value(user_id)
        with caplog.at_level(logging.WARNING):
            logging.getLogger("hushh_mcp.services.one_location_agent_service").warning(
                "one.location.notification_send_failed type=%s user=%s error=%s",
                "push",
                redacted,
                "timeout",
            )
        messages = [r.message for r in caplog.records]
        assert any("notification_send_failed" in m for m in messages)
        assert not any("firebase-uid-abc123" in m for m in messages)

    def test_identity_lookup_failed_redacts_user_id(self, caplog):
        """identity_lookup_failed must not log raw user_id."""
        from mcp_modules.log_redaction import redact_log_value
        user_id = "uid-secret-xyz"
        redacted = redact_log_value(user_id)
        with caplog.at_level(logging.DEBUG):
            logging.getLogger("hushh_mcp.services.one_location_agent_service").debug(
                "one.location.identity_lookup_failed user=%s error=%s",
                redacted,
                "db timeout",
            )
        messages = [r.message for r in caplog.records]
        assert any("identity_lookup_failed" in m for m in messages)
        assert not any("uid-secret-xyz" in m for m in messages)

    def test_redact_log_value_masks_user_id_string(self):
        """redact_log_value must redact a plain user_id string."""
        from mcp_modules.log_redaction import redact_log_value, REDACTED
        result = redact_log_value("some-firebase-uid")
        assert result == REDACTED

    def test_redact_log_value_masks_user_id_in_dict(self):
        """redact_log_value must redact user_id key in a dict."""
        from mcp_modules.log_redaction import redact_log_value, REDACTED
        payload = {"user_id": "uid-abc", "type": "push"}
        result = redact_log_value(payload)
        assert result["user_id"] == REDACTED
        assert result["type"] == "push"
