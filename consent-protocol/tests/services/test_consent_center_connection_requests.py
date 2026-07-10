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
