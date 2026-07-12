from pathlib import Path


def test_uat_consent_report_excludes_sensitive_columns_and_redacts_users() -> None:
    source = (
        Path(__file__).resolve().parents[1] / "scripts/report_consent_audit_window.py"
    ).read_text()
    assert "COUNT(*)::bigint" in source
    assert "_redact_identifier" in source
    assert "tokens, emails, requests, metadata payloads, and PKM data are excluded" in source
    assert "consent_token" not in source
    assert "encrypted_data" not in source
    assert "database_unavailable" in source
