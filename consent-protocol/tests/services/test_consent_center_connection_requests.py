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


def test_incoming_entries_surface_public_scope_proposals_for_selection():
    """Connection review exposes proposal presentation only, never raw scopes."""
    svc = ConsentCenterService.__new__(ConsentCenterService)

    fake_conn = MagicMock()
    fake_conn.list_requests.return_value = [
        {
            "id": "req-scoped",
            "counterpartUserId": "ria-1",
            "counterpartDisplayName": "Ada RIA",
            "message": "sharing a pick",
            "scopes": [
                {
                    "scopeHandle": "scp_1",
                    "direction": "requested",
                    "label": "RIA Picks",
                    "description": "Use this RIA's published investment picks.",
                    "status": "pending",
                }
            ],
        },
        {
            "id": "req-plain",
            "counterpartUserId": "friend-1",
            # no scopes key at all → plain connect
        },
    ]

    with patch(
        "hushh_mcp.services.consent_center_service.ConnectionsService",
        return_value=fake_conn,
    ):
        entries = asyncio.run(svc._incoming_connection_request_entries("user-a"))

    by_id = {e["id"]: e for e in entries}
    assert by_id["req-scoped"]["metadata"]["scope_proposals"] == [
        {
            "scopeHandle": "scp_1",
            "direction": "requested",
            "label": "RIA Picks",
            "description": "Use this RIA's published investment picks.",
            "status": "pending",
        }
    ]
    assert by_id["req-scoped"]["kind"] == "connection_request"
    assert by_id["req-plain"]["metadata"]["scope_proposals"] == []
    fake_conn.list_requests.assert_called_once_with("user-a", direction="incoming")
