import logging
from typing import Literal, Optional

from db.db_client import get_db

logger = logging.getLogger(__name__)


class _OwnershipChanged(Exception):
    pass


Platform = Literal["web", "ios", "android"]

# One registry owner, with a v1 compatibility projection for serving/rollback
# revisions. Prefer installation metadata and the newest legacy token owner.
LEGACY_REGISTRY_OWNER_FILTER = """
 NOT EXISTS (SELECT 1 FROM user_push_installations current WHERE current.token=l.token)
 AND NOT EXISTS (SELECT 1 FROM user_push_tokens newer WHERE newer.token=l.token
  AND (COALESCE(newer.updated_at,newer.created_at),newer.id)
    > (COALESCE(l.updated_at,l.created_at),l.id))
"""
PUSH_TOKEN_REGISTRY_SQL = f"""
 SELECT id,user_id,token,platform,device_id,preview_key_id,preview_public_key,
   'installation' AS source FROM user_push_installations p
 WHERE NOT EXISTS (SELECT 1 FROM account_deletion_tombstones t
  WHERE t.user_id_hash='sha256:' || encode(digest(p.user_id,'sha256'),'hex'))
 UNION ALL
 SELECT id,user_id,token,platform,device_id,preview_key_id,preview_public_key,
   'legacy' AS source FROM user_push_tokens l WHERE {LEGACY_REGISTRY_OWNER_FILTER}
 AND NOT EXISTS (SELECT 1 FROM account_deletion_tombstones t
  WHERE t.user_id_hash='sha256:' || encode(digest(l.user_id,'sha256'),'hex'))
"""  # nosec B608 # Only the fixed registry-owner predicate is interpolated; owner values are bound.
PUSH_TOKENS_FOR_USER_SQL = f"""
 SELECT token,platform FROM ({PUSH_TOKEN_REGISTRY_SQL}) registrations WHERE user_id=:user_id
"""  # nosec B608 # Composes the fixed registry query; user_id remains a bound parameter.


def remove_stale_push_token(db, user_id: str, token: str) -> None:
    # Always legacy first, matching registration/its DB reconciliation trigger.
    result = db.execute_raw(
        """WITH legacy AS (
          DELETE FROM user_push_tokens WHERE user_id=:user_id AND token=:token RETURNING token
        ), modern AS (
          DELETE FROM user_push_installations WHERE user_id=:user_id AND token=:token
            AND (SELECT count(*) FROM legacy)>=0 RETURNING token
        ) SELECT token FROM modern UNION SELECT token FROM legacy""",
        {"user_id": user_id, "token": token},
    )
    if result.error:
        raise RuntimeError("Failed to retire push token")
    restore_legacy_push_projection(db, user_id)


def restore_legacy_push_projection(db, user_id: str) -> None:
    result = db.execute_raw("SELECT restore_legacy_push_projection(:user_id)", {"user_id": user_id})
    if result.error:
        raise RuntimeError("Failed to restore compatible push registration")


class PushTokensService:
    """
    Service-layer wrapper for push token persistence.

    NOTE: Routes must not import db clients directly; they should call this service.
    """

    def upsert_user_push_token(
        self,
        user_id: str,
        token: str,
        platform: Platform,
        *,
        device_id: str | None = None,
        preview_key_id: str | None = None,
        preview_public_key: str | None = None,
    ) -> Optional[int]:
        db = get_db()

        sql = """
            INSERT INTO user_push_installations (user_id, token, platform, device_id,
              preview_key_id, preview_public_key, created_at, updated_at)
            VALUES (:user_id, :token, :platform, COALESCE(CAST(:device_id AS uuid), gen_random_uuid()),
              CAST(:preview_key_id AS uuid), :preview_public_key, NOW(), NOW())
            ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id,
              platform = EXCLUDED.platform, device_id = COALESCE(CAST(:device_id AS uuid), user_push_installations.device_id),
              preview_key_id = EXCLUDED.preview_key_id, preview_public_key = EXCLUDED.preview_public_key,
              updated_at = NOW()
            RETURNING id
        """

        legacy_sql = """
            INSERT INTO user_push_tokens(user_id,token,platform,created_at,updated_at)
            VALUES(:user_id,:token,:platform,now(),now())
            ON CONFLICT(user_id,platform) DO UPDATE SET token=EXCLUDED.token,
              preview_key_id=NULL, preview_public_key=NULL, updated_at=now()
            RETURNING id
        """
        owner_sql = """
            SELECT user_id FROM user_push_installations WHERE token=:token OR device_id=CAST(:device AS uuid)
            UNION SELECT user_id FROM user_push_tokens WHERE token=:token OR device_id=CAST(:device AS uuid)
        """
        # Serialize both token and installation ownership, including rotation.
        from sqlalchemy import text
        from sqlalchemy.exc import DBAPIError

        from hushh_mcp.services.account_deletion_lifecycle_service import (
            AccountDeletionLifecycleService,
            _postgres_sqlstate,
        )

        for attempt in range(3):
            try:
                with db.engine.begin() as conn:
                    old_users = (
                        conn.execute(
                            text(owner_sql),
                            {"token": token, "device": device_id},
                        )
                        .scalars()
                        .all()
                    )
                    AccountDeletionLifecycleService.lock_user_writes_in_transaction(
                        conn, user_ids={user_id, *old_users}
                    )
                    for lock in sorted(
                        {f"push-token:{token}", f"push-device:{device_id or token}"}
                    ):
                        conn.execute(
                            text("SELECT pg_advisory_xact_lock(hashtextextended(:lock, 0))"),
                            {"lock": lock},
                        )
                    current_users = set(
                        conn.execute(
                            text(owner_sql),
                            {"token": token, "device": device_id},
                        )
                        .scalars()
                        .all()
                    )
                    if not current_users.issubset({user_id, *old_users}):
                        raise _OwnershipChanged()
                    conn.execute(
                        text("SELECT set_config('hushh.push_installation_projection','1',true)")
                    )
                    if device_id:
                        # Account changes may also rotate the provider token. Retire
                        # the old installation's legacy shadow before its modern row.
                        conn.execute(
                            text("""DELETE FROM user_push_tokens legacy USING user_push_installations installation
                              WHERE installation.device_id=CAST(:device AS uuid)
                                AND installation.token<>:token
                                AND legacy.token=installation.token AND legacy.user_id=installation.user_id"""),
                            {"device": device_id, "token": token},
                        )
                    conn.execute(
                        text("DELETE FROM user_push_tokens WHERE token=:token AND user_id<>:user"),
                        {"token": token, "user": user_id},
                    )
                    legacy_row = (
                        conn.execute(
                            text(legacy_sql),
                            {"user_id": user_id, "token": token, "platform": platform},
                        )
                        .mappings()
                        .first()
                    )
                    # The legacy projection and its trigger always precede modern
                    # row locks. Old handlers keep their original conflict target.
                    conn.execute(
                        text(
                            "DELETE FROM user_push_installations WHERE token=:token AND user_id<>:user"
                        ),
                        {"token": token, "user": user_id},
                    )
                    if device_id:
                        conn.execute(
                            text(
                                "DELETE FROM user_push_installations WHERE device_id=CAST(:device AS uuid) AND token<>:token"
                            ),
                            {"device": device_id, "token": token},
                        )
                    else:
                        # Older clients cannot retain a former account's preview.
                        conn.execute(
                            text("DELETE FROM user_push_installations WHERE token=:token"),
                            {"token": token},
                        )
                        row = legacy_row
                    if device_id:
                        row = (
                            conn.execute(
                                text(sql),
                                {
                                    "user_id": user_id,
                                    "token": token,
                                    "platform": platform,
                                    "device_id": device_id,
                                    "preview_key_id": preview_key_id,
                                    "preview_public_key": preview_public_key,
                                },
                            )
                            .mappings()
                            .first()
                        )
                for former_owner in sorted(set(old_users)):
                    restore_legacy_push_projection(db, former_owner)
                return int(row["id"]) if row else None
            except _OwnershipChanged:
                if attempt == 2:
                    raise RuntimeError("Push ownership changed; retry registration") from None
            except DBAPIError as exc:
                state = _postgres_sqlstate(exc)
                ownership_conflict = (
                    state == "23505"
                    and getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
                    == "user_push_tokens_token_owner"
                )
                if attempt == 2 or (state not in {"40P01", "40001"} and not ownership_conflict):
                    raise
        return None

    def delete_user_push_tokens(
        self, user_id: str, platform: Optional[Platform] = None, *, device_id: str | None = None
    ) -> int:
        """Delete push tokens for a user. If platform is given, only that platform's token is removed."""
        db = get_db()

        params = {"uid": user_id, "device": device_id, "platform": platform}
        sql = """
          WITH targets AS (
            SELECT token FROM user_push_installations WHERE user_id=:uid
              AND ((CAST(:device AS uuid) IS NOT NULL AND device_id=CAST(:device AS uuid))
                OR (CAST(:device AS uuid) IS NULL AND (:platform IS NULL OR platform=:platform)))
            UNION SELECT token FROM user_push_tokens WHERE user_id=:uid
              AND ((CAST(:device AS uuid) IS NOT NULL AND device_id=CAST(:device AS uuid))
                OR (CAST(:device AS uuid) IS NULL AND (:platform IS NULL OR platform=:platform)))
          ), legacy AS (
            DELETE FROM user_push_tokens WHERE user_id=:uid AND token IN (SELECT token FROM targets) RETURNING token
          ), modern AS (
            DELETE FROM user_push_installations WHERE user_id=:uid AND token IN (SELECT token FROM targets)
              AND (SELECT count(*) FROM legacy)>=0 RETURNING token
          ) SELECT token FROM modern UNION SELECT token FROM legacy
        """
        result = db.execute_raw(sql, params)
        if result.error:
            logger.error("Push token delete failed")
            raise RuntimeError("Failed to delete push token(s)")
        restore_legacy_push_projection(db, user_id)
        return len(result.data) if result.data else 0
