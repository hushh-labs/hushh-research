from types import SimpleNamespace
from unittest.mock import patch

from hushh_mcp.services.one_location_agent_service import OneLocationAgentService


class _CapturingDB:
    def __init__(self):
        self.last_sql = None

    def execute_raw(self, sql, params=None):
        self.last_sql = sql
        return SimpleNamespace(data=[])


def test_list_verified_recipients_no_longer_uses_blanket_phone_verified():
    svc = OneLocationAgentService.__new__(OneLocationAgentService)
    db = _CapturingDB()
    with patch("hushh_mcp.services.one_location_agent_service.get_db", lambda: db):
        # _apply_kai_circle_recommendations may call the directory again; empty data is fine.
        svc.list_verified_recipients(owner_user_id="user-a")
    assert "phone_verified = TRUE" not in db.last_sql
    assert "trusted_connections" in db.last_sql
