"""Worker authority rejects timestamp-only (legacy lifetime) team resolution."""

from datetime import datetime, timezone
from unittest.mock import MagicMock

from hushh_mcp.services.one_referral_circle_service import resolve_contributing_circle


def test_legacy_interval_alone_never_proves_weekly_opt_in():
    connection = MagicMock()
    assert (
        resolve_contributing_circle(connection, user_id="owner", as_of=datetime.now(timezone.utc))
        is None
    )
    connection.execute.assert_not_called()
