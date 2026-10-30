from __future__ import annotations

import json

import hushh_mcp.services.kyc_debug_log as debug_log


def test_kyc_debug_log_is_opt_in_and_sanitized(monkeypatch, tmp_path):
    path = tmp_path / "logs" / "kyc-debug.log"
    monkeypatch.setenv("KYC_DEBUG_LOGGING", "true")
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setattr(debug_log, "_debug_log_path", lambda: path)

    token = debug_log.bind_run("run-123")
    try:
        debug_log.trace(
            "gmail.fetch.completed",
            eligible_count=2,
            email_body="this must not become a full sentence with spaces",
        )
    finally:
        debug_log.unbind_run(token)

    event = json.loads(path.read_text().strip())
    assert event["run_id"] == "run-123"
    assert event["eligible_count"] == 2
    assert "email_body" not in event


def test_kyc_debug_log_cannot_write_in_hosted_environments(monkeypatch, tmp_path):
    path = tmp_path / "logs" / "kyc-debug.log"
    monkeypatch.setenv("KYC_DEBUG_LOGGING", "true")
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setattr(debug_log, "_debug_log_path", lambda: path)

    debug_log.trace("scan.started")

    assert not path.exists()
