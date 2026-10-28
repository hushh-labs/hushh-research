from unittest.mock import patch

import pytest

from hushh_mcp.services.connections_service import ConnectionsService


@pytest.mark.parametrize("verified", [True, False, None])
def test_connection_email_verification_comes_from_counterpart_identity(verified):
    service = ConnectionsService.__new__(ConnectionsService)
    statements: list[str] = []

    def rows(sql, _params):
        statements.append(sql)
        return [
            {
                "connection_id": "connection",
                "user_id": "peer",
                "email": "peer@example.test",
                "email_verified": verified,
            }
        ]

    with (
        patch.object(service, "_execute_many", side_effect=rows),
        patch.object(service, "_verified_ria_user_ids", return_value=set()),
        patch.object(service, "_public_person_refs", return_value={}),
    ):
        result = service.list_connections("owner")

    assert result[0]["email"] == "peer@example.test"
    assert result[0]["emailVerified"] is (verified is True)
    assert "a.email_verified" in statements[0]
