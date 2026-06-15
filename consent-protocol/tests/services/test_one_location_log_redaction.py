"""
Tests for log redaction in OneLocationAgentService.
Exercises real service call sites to prove user_id does not
appear in plaintext in production log output.
"""

import logging
from unittest.mock import patch

from mcp_modules.log_redaction import REDACTED, redact_log_value


class TestOneLocationLogRedaction:
    """user_id must never appear in plaintext in location service logs."""

    def test_notification_send_failed_redacts_user_id(self, caplog):
        """Real _deliver path must not log raw user_id on send failure."""
        from hushh_mcp.services.one_location_agent_service import OneLocationAgentService
        svc = OneLocationAgentService.__new__(OneLocationAgentService)
        raw_user_id = "firebase-uid-abc123"
        with patch("hushh_mcp.services.one_location_agent_service.ensure_firebase_admin"),\
             patch("hushh_mcp.services.one_location_agent_service.get_db", side_effect=RuntimeError("db down")),\
             caplog.at_level(logging.WARNING, logger="hushh_mcp.services.one_location_agent_service"):
            svc._send_push_notification(
                user_id=raw_user_id,
                notification_type="push",
                title="Test",
                body="Test body",
            )
        assert raw_user_id not in caplog.text
        assert any("notification" in r.message for r in caplog.records)

    def test_identity_lookup_failed_redacts_user_id(self, caplog):
        """Real _identity_row path must not log raw user_id on db failure."""
        from hushh_mcp.services.one_location_agent_service import OneLocationAgentService
        svc = OneLocationAgentService.__new__(OneLocationAgentService)
        raw_user_id = "uid-secret-xyz"
        with patch("hushh_mcp.services.one_location_agent_service.get_db", side_effect=RuntimeError("db down")),\
             caplog.at_level(logging.DEBUG, logger="hushh_mcp.services.one_location_agent_service"):
            result = svc._identity_row(raw_user_id)
        assert result is None
        assert raw_user_id not in caplog.text
        assert any("identity_lookup_failed" in r.message for r in caplog.records)

    def test_redact_log_value_masks_user_id_string(self):
        """redact_log_value must redact a plain user_id string."""
        result = redact_log_value("some-firebase-uid")
        assert result == REDACTED

    def test_redact_log_value_masks_user_id_in_dict(self):
        """redact_log_value must redact user_id key in a dict."""
        payload = {"user_id": "uid-abc", "type": "push"}
        result = redact_log_value(payload)
        assert result["user_id"] == REDACTED
        assert result["type"] == "push"
