"""Closed diagnostic projection at the existing private Drive error boundary."""

import pytest

from api.routes.drive_sharing_owner import sharing_error
from hushh_mcp.services.drive_sharing_contract import DriveSharingError


@pytest.mark.parametrize(
    "code,reason,exposed",
    [
        ("invalid_argument", "owner_copy_consent_missing", True),
        ("invalid_argument", "owner_copy_consent_unexpected", True),
        ("invalid_argument", "private-purpose-token", False),
        ("sharing_unavailable", "owner_copy_consent_missing", False),
    ],
)
def test_copy_consent_diagnostic_is_closed(code, reason, exposed):
    error = sharing_error(DriveSharingError(code, diagnostic_reason=reason))
    assert error.status_code == (422 if code == "invalid_argument" else 503)
    assert error.detail["code"] == code
    assert "no-store" in error.headers["Cache-Control"]
    if exposed:
        assert error.detail["reason"] == reason
    else:
        assert "reason" not in error.detail
        assert "private-purpose-token" not in str(error.detail)
