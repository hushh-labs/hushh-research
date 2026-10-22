"""Fresh account identity and setup admission for independent One features."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from api.utils.firebase_admin import get_firebase_auth_app
from db.connection import get_pool


class OwnerIdentityUnavailable(RuntimeError):
    """The current account identity could not be established."""


async def owner_setup_resolved(
    user_id: str, *, pool_provider: Callable[[], Awaitable[Any]] | None = None, conn: Any = None
) -> bool:
    """Read canonical completion without writes or feature-specific eligibility."""

    async def read(connection):
        return await connection.fetchrow(
            "SELECT setup_completed, vault_status FROM vault_keys WHERE user_id = $1 LIMIT 1",
            user_id,
            timeout=5,
        )

    if conn is not None:
        row = await read(conn)
    else:
        pool = await (pool_provider or get_pool)()
        async with pool.acquire() as connection:
            row = await read(connection)
    return bool(row and row["setup_completed"] is True and row["vault_status"] == "active")


def lookup_fresh_owner_identity(user_id: str, *, app_provider: Callable[[], Any] | None = None):
    """Run this synchronous provider read off the API event loop."""
    # Firebase's shared helper sets a four-second HTTP timeout.
    app = (app_provider or get_firebase_auth_app)()
    if app is None:
        raise OwnerIdentityUnavailable()
    from firebase_admin import auth as firebase_auth

    return firebase_auth.get_user(user_id, app=app)
