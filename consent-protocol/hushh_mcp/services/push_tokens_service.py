import hashlib
import logging
from typing import Literal, Optional

from sqlalchemy import text

from db.db_client import get_db

logger = logging.getLogger(__name__)

Platform = Literal["web", "ios", "android"]


class PushTokensService:
    """
    Service-layer wrapper for push token persistence.

    NOTE: Routes must not import db clients directly; they should call this service.
    """

    def upsert_user_push_token(self, user_id: str, token: str, platform: Platform) -> Optional[int]:
        db = get_db()

        sql = """
            INSERT INTO user_push_tokens (user_id, token, platform, created_at, updated_at)
            VALUES (:user_id, :token, :platform, NOW(), NOW())
            ON CONFLICT (user_id, platform)
            DO UPDATE SET token = EXCLUDED.token, updated_at = NOW()
            RETURNING id
        """

        params = {"user_id": user_id, "token": token, "platform": platform}
        # One physical token has one account authority, including simultaneous
        # account transfers. The compatibility table keeps older clients valid.
        lock = int.from_bytes(hashlib.sha256(token.encode()).digest()[:8], "big", signed=True)
        with db.engine.begin() as connection:
            connection.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock})
            connection.execute(
                text("DELETE FROM user_push_tokens WHERE token = :token AND user_id <> :user_id"),
                params,
            )
            if connection.execute(
                text("SELECT to_regclass('public.user_push_devices') IS NOT NULL")
            ).scalar():
                connection.execute(
                    text(
                        "DELETE FROM user_push_devices WHERE token = :token AND user_id <> :user_id"
                    ),
                    params,
                )
                connection.execute(
                    text("""
                    INSERT INTO user_push_devices (user_id, token, platform, created_at, updated_at)
                    SELECT :user_id, :token, :platform, NOW(), NOW()
                    FROM actor_profiles WHERE user_id = :user_id
                    ON CONFLICT (token) DO UPDATE SET
                        platform = EXCLUDED.platform, updated_at = NOW()
                """),
                    params,
                )
            row = connection.execute(text(sql), params).mappings().first()
        return int(row["id"]) if row and row.get("id") is not None else None

    def delete_user_push_tokens(
        self, user_id: str, platform: Optional[Platform] = None, token: str | None = None
    ) -> int:
        """Delete push tokens for a user. If platform is given, only that platform's token is removed."""
        db = get_db()

        if platform:
            sql = "DELETE FROM user_push_tokens WHERE user_id = :uid AND platform = :platform"
            params = {"uid": user_id, "platform": platform}
        else:
            sql = "DELETE FROM user_push_tokens WHERE user_id = :uid"
            params = {"uid": user_id}

        if token:
            sql += " AND token = :token"
            params["token"] = token
        sql += " RETURNING id"

        with db.engine.begin() as connection:
            if connection.execute(
                text("SELECT to_regclass('public.user_push_devices') IS NOT NULL")
            ).scalar():
                connection.execute(
                    text(sql.replace("user_push_tokens", "user_push_devices")), params
                )
            return len(connection.execute(text(sql), params).all())
