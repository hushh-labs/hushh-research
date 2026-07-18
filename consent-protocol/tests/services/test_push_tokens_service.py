from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from hushh_mcp.services.push_tokens_service import PushTokensService

TEST_PUSH_VALUE = "sample_value"  # nosec B105


def test_upsert_user_push_token_raises_on_db_error():
    fake_db = Mock()

    fake_db.execute_raw.return_value = SimpleNamespace(
        data=[],
        error="boom",
    )

    with patch(
        "hushh_mcp.services.push_tokens_service.get_db",
        return_value=fake_db,
    ):
        service = PushTokensService()

        with pytest.raises(RuntimeError):
            service.upsert_user_push_token(
                user_id="user1",
                token=TEST_PUSH_VALUE,
                platform="web",
            )
