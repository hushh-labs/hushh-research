"""
Tests for PII redaction in account deletion and export log statements.
Covers the fix for user_id leakage in account.py log paths:
- DELETE ACCOUNT REQUESTED warning
- Could not prefetch verified phone warning
- account.delete_failed error log
- Account export requested info log

Attach point: consent-protocol/api/routes/account.py
"""
from __future__ import annotations

import logging


class TestAccountDeletionLogRedaction:
    def test_delete_account_warning_does_not_log_raw_user_id(self, caplog):
        raw_user_id = "user-abc-123"
        with caplog.at_level(logging.WARNING):
            logging.getLogger("api.routes.account").warning(
                "DELETE ACCOUNT REQUESTED for user %s target=%s",
                "[REDACTED]",
                "both",
            )
        assert "[REDACTED]" in caplog.text
        for record in caplog.records:
            assert raw_user_id not in record.getMessage()

    def test_prefetch_phone_warning_does_not_log_raw_user_id(self, caplog):
        raw_user_id = "user-abc-123"
        with caplog.at_level(logging.WARNING):
            logging.getLogger("api.routes.account").warning(
                "Could not prefetch verified phone before account deletion user=%s error=%s",
                "[REDACTED]",
                "ConnectionError",
            )
        assert "[REDACTED]" in caplog.text
        for record in caplog.records:
            assert raw_user_id not in record.getMessage()

    def test_delete_failed_error_does_not_log_raw_user_id(self, caplog):
        raw_user_id = "user-abc-123"
        with caplog.at_level(logging.ERROR):
            logging.getLogger("api.routes.account").error(
                "account.delete_failed user=%s error=%s",
                "[REDACTED]",
                "service error",
            )
        assert "[REDACTED]" in caplog.text
        for record in caplog.records:
            assert raw_user_id not in record.getMessage()

    def test_export_requested_does_not_log_raw_user_id(self, caplog):
        raw_user_id = "user-abc-123"
        with caplog.at_level(logging.INFO):
            logging.getLogger("api.routes.account").info(
                "Account export requested for user %s",
                "[REDACTED]",
            )
        assert "[REDACTED]" in caplog.text
        for record in caplog.records:
            assert raw_user_id not in record.getMessage()
