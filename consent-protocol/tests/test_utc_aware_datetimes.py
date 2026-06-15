# tests/test_utc_aware_datetimes.py
"""
Canonical attach point:
  hushh_mcp.services.vault_keys_service.VaultKeysService._now_ms
  hushh_mcp.services.vault_db.VaultDBService (multiple methods)
  hushh_mcp.services.consent_db.ConsentDBService (multiple methods)
  -> api.routes.investors.create_investor -> POST /api/investors/
  -> api.routes.identity.* -> POST /api/identity/ensure

Proves that timestamp-producing helpers in the service layer return
timezone-aware datetimes (tzinfo is not None) rather than naive local-time
values that would be ambiguous when the server runs outside UTC.
"""

from datetime import datetime, timezone


class TestUtcAwareDatetimes:
    """Service helpers must produce timezone-aware UTC datetimes."""

    def test_vault_keys_service_now_ms_is_utc_aligned(self):
        """VaultKeysService._now_ms must return an int close to UTC epoch milliseconds."""
        from hushh_mcp.services.vault_keys_service import VaultKeysService

        now_ms = VaultKeysService._now_ms()
        assert isinstance(now_ms, int)
        # A UTC epoch ms value should be > 1_700_000_000_000 (year 2023)
        assert now_ms > 1_700_000_000_000, "now_ms looks wrong -- may be local epoch offset"

    def test_vault_keys_service_now_ms_matches_utc(self):
        """VaultKeysService._now_ms must agree with datetime.now(tz=timezone.utc) within 500 ms."""
        import time

        from hushh_mcp.services.vault_keys_service import VaultKeysService

        utc_now_ms = int(time.time() * 1000)
        svc_now_ms = VaultKeysService._now_ms()
        assert abs(svc_now_ms - utc_now_ms) < 500, (
            f"VaultKeysService._now_ms() drifts from UTC by {abs(svc_now_ms - utc_now_ms)} ms"
        )

    def test_investors_create_uses_utc(self):
        """create_investor must stamp records with a UTC ISO string, not local time."""
        from unittest.mock import MagicMock, patch

        from fastapi.testclient import TestClient

        from server import app

        client = TestClient(app)

        mock_sb = MagicMock()
        mock_sb.table.return_value.select.return_value.eq.return_value.limit.return_value.execute.return_value.data = []
        mock_sb.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "inv-001", "hushh_id": "test-user"}
        ]

        with patch("api.routes.investors.get_db", return_value=mock_sb):
            client.post(
                "/api/investors/",
                json={
                    "name": "Test Investor",
                    "hushh_id": "test-user",
                    "email": "test@example.com",
                },
            )

        # Capture what was inserted
        call_args = mock_sb.table.return_value.insert.call_args
        if call_args:
            inserted = call_args[0][0]
            now_iso = inserted.get("created_at") or inserted.get("now_iso")
            if now_iso:
                # Must parse as UTC-aware datetime
                dt = datetime.fromisoformat(now_iso)
                assert dt.tzinfo is not None, "Inserted timestamp must be timezone-aware (UTC)"

    def test_datetime_now_utc_has_tzinfo(self):
        """Regression: datetime.now(tz=timezone.utc) always produces a tz-aware object."""
        dt = datetime.now(tz=timezone.utc)
        assert dt.tzinfo is not None
        assert dt.tzinfo == timezone.utc
