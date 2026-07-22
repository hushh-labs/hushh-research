from hushh_mcp.services.one_location_agent_service import OneLocationAgentService


def test_expire_stale_grants_uses_non_reserved_update_alias(monkeypatch) -> None:
    captured: dict[str, str] = {}
    service = object.__new__(OneLocationAgentService)

    def capture(sql: str, _params: dict) -> list[dict]:
        captured["sql"] = sql
        return []

    monkeypatch.setattr(service, "_execute_many", capture)

    service._expire_stale_grants("user-1")

    normalized = " ".join(captured["sql"].split())
    assert "UPDATE one_location_share_grants AS location_grant" in normalized
    assert "WHERE location_grant.id = stale.id" in normalized
    assert "UPDATE one_location_share_grants grant" not in normalized
