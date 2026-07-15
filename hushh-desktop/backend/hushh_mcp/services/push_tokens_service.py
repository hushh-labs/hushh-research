import logging
from typing import Literal, Optional

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

        result = db.execute_raw(
            sql,
            {"user_id": user_id, "token": token, "platform": platform},
        )

        if result.error:
            logger.error("Push token upsert failed: %s", result.error)
            raise RuntimeError("Failed to register push token")

        row = result.data[0] if result.data else None
        return int(row["id"]) if row and row.get("id") is not None else None

    def delete_user_push_tokens(self, user_id: str, platform: Optional[Platform] = None) -> int:
        """Delete push tokens for a user. If platform is given, only that platform's token is removed."""
        db = get_db()

        if platform:
            sql = "DELETE FROM user_push_tokens WHERE user_id = :uid AND platform = :platform"
            params = {"uid": user_id, "platform": platform}
        else:
            sql = "DELETE FROM user_push_tokens WHERE user_id = :uid"
            params = {"uid": user_id}

        result = db.execute_raw(sql, params)

        if result.error:
            logger.error("Push token delete failed: %s", result.error)
            raise RuntimeError("Failed to delete push token(s)")

        # execute_raw may return the deleted rows or empty list
        return len(result.data) if result.data else 0
