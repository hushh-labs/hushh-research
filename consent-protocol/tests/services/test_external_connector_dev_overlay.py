"""A local run derives manifest-backed connector rows read-only, never from the shared row.

Localhost shares the UAT database, so a stale shared row (Notion's, written before
the manifest contract) shows a dead card, and "fixing" it from a laptop edits UAT.
The registry therefore overlays rows derived from the checked-in manifests, but only
in a loopback development runtime, and never writes.
"""

import sqlite3
from types import SimpleNamespace

import pytest

from hushh_mcp.services import connector_dev_runtime
from hushh_mcp.services.curated_connector_manifest import get_manifest
from hushh_mcp.services.external_connector_registry_service import ExternalConnectorRegistryService

LOCAL_ORIGIN = "http://localhost:3000"
UAT_RETURN = "https://uat.one.hushh.ai/one/profile/connectors/oauth/return"


def _develop(monkeypatch, origin: str = LOCAL_ORIGIN, environment: str = "development") -> None:
    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setattr(
        connector_dev_runtime,
        "get_app_runtime_settings",
        lambda: SimpleNamespace(app_frontend_origin=origin),
    )


@pytest.fixture
def registry():
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """CREATE TABLE external_mcp_connectors (
          connector_id TEXT PRIMARY KEY, display_name TEXT, description TEXT,
          mcp_endpoint TEXT, auth_style TEXT, oauth_authorize_url TEXT, oauth_token_url TEXT,
          oauth_scopes TEXT, oauth_client_id_env TEXT, oauth_client_secret_env TEXT,
          user_id TEXT, is_active BOOLEAN, owner_enabled BOOLEAN
        )"""
    )
    connection.executemany(
        "INSERT INTO external_mcp_connectors (connector_id, display_name, mcp_endpoint, auth_style,"
        " oauth_client_secret_env, user_id, is_active, owner_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            ("public", "Public", "https://public.example/mcp", "oauth", None, None, True, False),
            # Notion's September row: it carries a client secret the manifest no longer has.
            (
                "notion",
                "Notion",
                "https://mcp.notion.com/mcp",
                "oauth",
                "NOTION_OAUTH_CLIENT_SECRET",
                None,
                True,
                False,
            ),
            ("a-private", "Private", "https://a.example/mcp", "oauth", None, "a", False, True),
        ],
    )
    statements: list[str] = []

    def execute_raw(sql, params=None):
        statements.append(sql.strip().split(None, 1)[0].upper())
        return SimpleNamespace(data=[dict(row) for row in connection.execute(sql, params or {})])

    service = ExternalConnectorRegistryService(db=SimpleNamespace(execute_raw=execute_raw))
    yield service, connection, statements
    connection.close()


def _pinned(definition) -> bool:
    manifest = get_manifest(definition.connector_id)
    return bool(
        manifest is not None
        and (
            definition.mcp_endpoint,
            definition.oauth_authorize_url,
            definition.oauth_token_url,
            definition.oauth_scopes,
            definition.oauth_client_id_env,
            definition.oauth_client_secret_env,
        )
        == manifest.pin()
        and definition.registered_redirect_uris in manifest.redirect_uris.values()
        and definition.capability_policy.get("chat") == "reviewed"
    )


@pytest.mark.asyncio
async def test_a_stale_shared_row_is_replaced_by_its_manifest_in_development(registry, monkeypatch):
    service, connection, _ = registry
    _develop(monkeypatch)
    by_id = {item.connector_id: item for item in await service.list_active_connectors()}

    assert _pinned(by_id["notion"])
    assert by_id["notion"].oauth_client_secret_env is None
    assert by_id["notion"].registered_redirect_uris == (UAT_RETURN,)
    # The shared row itself is untouched: the overlay is derived, never written.
    stored = connection.execute(
        "SELECT oauth_client_secret_env FROM external_mcp_connectors WHERE connector_id='notion'"
    ).fetchone()
    assert stored["oauth_client_secret_env"] == "NOTION_OAUTH_CLIENT_SECRET"


@pytest.mark.asyncio
async def test_a_manifest_provider_with_no_row_still_appears_in_development(registry, monkeypatch):
    service, connection, _ = registry
    connection.execute("DELETE FROM external_mcp_connectors WHERE connector_id='notion'")
    _develop(monkeypatch)
    by_id = {item.connector_id: item for item in await service.list_active_connectors()}

    assert _pinned(by_id["notion"])
    assert _pinned(by_id["hubspot"])
    # Attio now has a reviewed runtime manifest, so it is overlaid and pinned too.
    assert _pinned(by_id["attio"])
    assert "public" in by_id


@pytest.mark.asyncio
async def test_a_registration_only_provider_is_never_overlaid_in_development(
    registry, monkeypatch, registration_only_provider
):
    service, _, _ = registry
    _develop(monkeypatch)
    by_id = {item.connector_id: item for item in await service.list_active_connectors()}

    # The registration contract is loaded, but with no tool policy it is not a
    # runtime provider: not overlaid, not fetchable, not in the curated list.
    assert registration_only_provider.connector_id == "pendingco"
    assert get_manifest("pendingco") is None
    assert "pendingco" not in by_id
    assert await service.get_connector("pendingco") is None
    assert "pendingco" not in {
        item.connector_id for item in await service.list_curated_connectors()
    }
    # The runtime providers are still overlaid alongside it.
    assert _pinned(by_id["attio"])
    assert _pinned(by_id["hubspot"])


@pytest.mark.asyncio
async def test_the_overlay_never_issues_a_write(registry, monkeypatch):
    service, _, statements = registry
    _develop(monkeypatch)
    await service.list_active_connectors()
    await service.list_active_connectors(user_id="a")
    await service.list_curated_connectors(include_inactive=True)
    await service.get_connector("notion")
    await service.get_connector("notion", include_inactive=True)

    assert statements
    assert set(statements) == {"SELECT"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("environment", "origin"),
    [
        ("production", LOCAL_ORIGIN),
        ("uat", LOCAL_ORIGIN),
        ("", LOCAL_ORIGIN),
        # A deployed origin must never enable it, even if ENVIRONMENT were wrong.
        ("development", "https://uat.one.hushh.ai"),
        ("development", "http://evil.example"),
        ("development", "http://localhost.evil.example:3000"),
    ],
)
async def test_the_overlay_is_off_everywhere_except_a_loopback_development_runtime(
    registry, monkeypatch, environment, origin
):
    service, _, _ = registry
    _develop(monkeypatch, origin=origin, environment=environment)
    by_id = {item.connector_id: item for item in await service.list_active_connectors()}

    # Exactly the database rows: the stale Notion row stays stale, nothing is added.
    assert set(by_id) == {"public", "notion"}
    assert by_id["notion"].oauth_client_secret_env == "NOTION_OAUTH_CLIENT_SECRET"
    assert not _pinned(by_id["notion"])
    assert await service.get_connector("hubspot") is None


@pytest.mark.asyncio
async def test_private_owner_rows_are_never_overlaid_or_hidden(registry, monkeypatch):
    service, _, _ = registry
    _develop(monkeypatch)
    ids = {item.connector_id for item in await service.list_active_connectors(user_id="a")}
    assert "a-private" in ids
    assert await service.get_connector("a-private") is None
    assert (await service.get_connector("a-private", user_id="a")).connector_id == "a-private"
    assert await service.get_connector("a-private", user_id="b") is None


@pytest.mark.asyncio
async def test_get_connector_and_the_curated_list_agree_with_the_active_list(registry, monkeypatch):
    service, _, _ = registry
    _develop(monkeypatch)
    derived = await service.get_connector("notion")
    curated = {item.connector_id: item for item in await service.list_curated_connectors()}

    assert derived is not None and _pinned(derived)
    assert curated["notion"] == derived
    assert _pinned(curated["hubspot"])


def test_the_loopback_predicate_accepts_only_plain_http_loopback(monkeypatch):
    for good in ("http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"):
        _develop(monkeypatch, origin=good)
        assert connector_dev_runtime.loopback_development_origin() == good
    for bad in (
        "https://localhost:3000",
        "http://user@localhost:3000",
        "http://localhost:3000/path",
        "http://localhost.evil.example",
        "",
    ):
        _develop(monkeypatch, origin=bad)
        assert connector_dev_runtime.loopback_development_origin() is None
