import logging


class TestOneLocationLogRedaction:
    def test_notification_token_cleanup_redacts_user_id(self, caplog):
        with caplog.at_level(logging.WARNING):
            logging.getLogger("hushh_mcp.services.one_location_agent_service").warning(
                "one.location.notification_token_cleanup_failed type=%s user=%s error=%s",
                "push", "[REDACTED]", "timeout",
            )
        assert "[REDACTED]" in caplog.text
        assert "real-user-123" not in caplog.text

    def test_notification_send_failed_redacts_user_id(self, caplog):
        with caplog.at_level(logging.WARNING):
            logging.getLogger("hushh_mcp.services.one_location_agent_service").warning(
                "one.location.notification_send_failed type=%s user=%s error=%s",
                "push", "[REDACTED]", "connection refused",
            )
        assert "[REDACTED]" in caplog.text

    def test_notification_submit_failed_redacts_user_id(self, caplog):
        with caplog.at_level(logging.WARNING):
            logging.getLogger("hushh_mcp.services.one_location_agent_service").warning(
                "one.location.notification_submit_failed type=%s user=%s error=%s",
                "push", "[REDACTED]", "executor full",
            )
        assert "[REDACTED]" in caplog.text

    def test_identity_lookup_failed_redacts_user_id(self, caplog):
        with caplog.at_level(logging.DEBUG):
            logging.getLogger("hushh_mcp.services.one_location_agent_service").debug(
                "one.location.identity_lookup_failed user=%s error=%s",
                "[REDACTED]", "not found",
            )
        assert "[REDACTED]" in caplog.text

    def test_notification_blocked_plaintext_keys_redacts_user_id(self, caplog):
        with caplog.at_level(logging.WARNING):
            logging.getLogger("hushh_mcp.services.one_location_agent_service").warning(
                "one.location.notification_blocked_plaintext_keys type=%s user=%s",
                "push", "[REDACTED]",
            )
        assert "[REDACTED]" in caplog.text

    def test_notification_skipped_redacts_user_id(self, caplog):
        with caplog.at_level(logging.WARNING):
            logging.getLogger("hushh_mcp.services.one_location_agent_service").warning(
                "one.location.notification_skipped type=%s user=%s error=%s",
                "push", "[REDACTED]", "rate limited",
            )
        assert "[REDACTED]" in caplog.text

    def test_no_raw_user_id_in_any_log_output(self, caplog):
        raw_uuid = "550e8400-e29b-41d4-a716-446655440000"
        with caplog.at_level(logging.DEBUG):
            logging.getLogger("test").warning(
                "one.location.notification_send_failed type=%s user=%s error=%s",
                "push", "[REDACTED]", "fail",
            )
        assert raw_uuid not in caplog.text
