import asyncio
from unittest.mock import MagicMock, patch

from hushh_mcp.services.consent_center_service import ConsentCenterService


def test_consents_pending_count_includes_incoming_connection_requests():
    svc = ConsentCenterService.__new__(ConsentCenterService)

    fake_conn = MagicMock()
    fake_conn.list_requests.return_value = [{"id": "req-1"}, {"id": "req-2"}]

    with patch(
        "hushh_mcp.services.consent_center_service.ConnectionsService",
        return_value=fake_conn,
    ):
        count = asyncio.run(svc._incoming_connection_request_count("user-a"))
    assert count == 2
    fake_conn.list_requests.assert_called_once_with("user-a", direction="incoming")


def test_incoming_entries_surface_requested_scopes_for_modify_flow():
    """A connection request that bundles a data ask must forward those scopes to
    the recipient so the consent center can offer "modify the list" (grant a
    subset). A plain connect with no ask must degrade to an empty list."""
    svc = ConsentCenterService.__new__(ConsentCenterService)

    fake_conn = MagicMock()
    fake_conn.list_requests.return_value = [
        {
            "id": "req-scoped",
            "counterpartUserId": "ria-1",
            "counterpartDisplayName": "Ada RIA",
            "message": "sharing a pick",
            "requestedScopes": ["vault.read.finance", "vault.read.portfolio"],
        },
        {
            "id": "req-plain",
            "counterpartUserId": "friend-1",
            # no requestedScopes key at all → plain connect
        },
    ]

    with patch(
        "hushh_mcp.services.consent_center_service.ConnectionsService",
        return_value=fake_conn,
    ):
        entries = asyncio.run(svc._incoming_connection_request_entries("user-a"))

    by_id = {e["id"]: e for e in entries}
    assert by_id["req-scoped"]["requested_scopes"] == [
        "vault.read.finance",
        "vault.read.portfolio",
    ]
    assert by_id["req-scoped"]["kind"] == "connection_request"
    # Plain connect: field is present and empty so the UI simply hides "Choose data".
    assert by_id["req-plain"]["requested_scopes"] == []
    fake_conn.list_requests.assert_called_once_with("user-a", direction="incoming")
