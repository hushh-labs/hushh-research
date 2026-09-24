"""Exercise registry SQL with real rows, not mocked authorization outcomes."""

import sqlite3
from types import SimpleNamespace

import pytest

from hushh_mcp.services.external_connector_registry_service import ExternalConnectorRegistryService


@pytest.fixture
def registry():
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """CREATE TABLE external_mcp_connectors (
          connector_id TEXT PRIMARY KEY, display_name TEXT, mcp_endpoint TEXT,
          auth_style TEXT, user_id TEXT, is_active BOOLEAN, owner_enabled BOOLEAN,
          CHECK ((user_id IS NULL AND owner_enabled = FALSE)
            OR (user_id IS NOT NULL AND length(trim(user_id)) > 0 AND is_active = FALSE))
        )"""
    )
    connection.executemany(
        "INSERT INTO external_mcp_connectors VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            ("public", "Public", "https://public.example/mcp", "oauth", None, True, False),
            ("a-private", "Private", "https://a.example/mcp", "oauth", "a", False, True),
            ("b-private", "Private", "https://b.example/mcp", "api_key", "b", False, True),
            ("a-disabled", "Disabled", "https://a.example/old", "oauth", "a", False, False),
        ],
    )

    def execute_raw(sql, params=None):
        return SimpleNamespace(data=[dict(row) for row in connection.execute(sql, params or {})])

    yield ExternalConnectorRegistryService(db=SimpleNamespace(execute_raw=execute_raw)), connection
    connection.close()


@pytest.mark.asyncio
async def test_catalog_is_owner_scoped_and_legacy_callers_remain_public_only(registry):
    service, _ = registry
    assert {item.connector_id for item in await service.list_active_connectors()} == {"public"}
    assert {item.connector_id for item in await service.list_active_connectors(user_id="a")} == {
        "public",
        "a-private",
    }
    assert {item.connector_id for item in await service.list_active_connectors(user_id="b")} == {
        "public",
        "b-private",
    }


@pytest.mark.asyncio
async def test_exact_id_does_not_bypass_owner_or_disabled_state(registry):
    service, _ = registry
    assert await service.get_connector("a-private") is None
    assert await service.get_connector("a-private", user_id="b") is None
    assert await service.get_connector("a-disabled", user_id="a") is None
    item = await service.get_connector("a-private", user_id="a")
    assert item is not None and item.is_active and item.owner_user_id == "a"
    public = item.to_public_dict()
    assert "owner_user_id" not in public and "mcp_endpoint" not in public


def test_private_row_cannot_be_published_to_legacy_readers(registry):
    _, connection = registry
    with pytest.raises(sqlite3.IntegrityError):
        connection.execute("UPDATE external_mcp_connectors SET is_active=TRUE WHERE user_id='a'")
