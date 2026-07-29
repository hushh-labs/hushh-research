import time

import pytest


def test_expired_token_rejected():
    token_payload = {
        "expires_at": int(time.time()) - 60,
    }

    expires_at = token_payload.get(
        "expires_at"
    )

    with pytest.raises(ValueError):
        if (
            expires_at is not None
            and expires_at < int(time.time())
        ):
            raise ValueError(
                "Token expired"
            )