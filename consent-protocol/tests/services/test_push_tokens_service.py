from types import SimpleNamespace
from unittest.mock import Mock, patch

from hushh_mcp.services.push_tokens_service import PushTokensService


def test_delete_user_push_tokens_with_platform():
    fake_db = Mock()

    fake_db.execute_raw.return_value = SimpleNamespace(
        data=[{}, {}],
        error=None,
    )

    with patch(
        "hushh_mcp.services.push_tokens_service.get_db",
        return_value=fake_db,
    ):
        service = PushTokensService()

        deleted = service.delete_user_push_tokens(
            user_id="user1",
            platform="ios",
        )

    assert deleted == 2

    sql, params = fake_db.execute_raw.call_args.args

    assert "platform" in sql
    assert params["platform"] == "ios"
