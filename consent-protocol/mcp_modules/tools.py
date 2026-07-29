import time


async def handle_validate_token(
    arguments,
):
    token_payload = {
        "expires_at": arguments.get(
            "expires_at"
        )
    }

    expires_at = token_payload.get(
        "expires_at"
    )

    if (
        expires_at is not None
        and expires_at < int(time.time())
    ):
        raise ValueError(
            "Token expired"
        )

    return {
        "status": "valid",
    }