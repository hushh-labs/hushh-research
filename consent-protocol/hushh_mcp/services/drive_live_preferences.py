"""Owner-controlled live Drive preparation authority, independent of the OAuth grant."""

from __future__ import annotations

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_document_store import DriveDocumentStore
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    DRIVE_POLICY,
    LIVE_POLICY_HASH,
    DriveReadError,
)

LIVE_BACKGROUND_DISCLOSURE = "live-drive-background-v1"


class DriveLivePreferences(DriveDocumentStore):
    def live_active(
        self,
        connection,
        *,
        user_id: str,
        generation: int | None = None,
        management: bool = False,
    ) -> dict:
        if not management and not connector_feature_enabled("google_drive_live", user_id):
            raise DriveReadError("connector_unavailable")
        row = self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
        policy = self._row(
            connection,
            "SELECT * FROM external_mcp_connectors WHERE connector_id='google_drive' FOR SHARE",
            {},
        )
        if (
            row["status"] != "connected"
            or row["validation_state"] != "verified"
            or row["verified_policy_hash"] != LIVE_POLICY_HASH
            or generation is not None
            and row["connection_generation"] != generation
            or not policy
            or not policy["is_active"]
            or policy["transport_kind"] != "google_drive_rest"
            or policy["mcp_endpoint"] != DRIVE_BASE
            or policy["capability_policy"] != DRIVE_POLICY
        ):
            raise DriveReadError("connection_changed")
        return row

    def background_current(self, connection, *, user_id: str, generation: int) -> dict:
        self.live_active(connection, user_id=user_id, generation=generation)
        preference = self._row(
            connection,
            """SELECT * FROM drive_live_preferences WHERE user_id=:user FOR SHARE""",
            {"user": user_id},
        )
        if (
            not preference
            or preference["connection_generation"] != generation
            or preference["background_enabled"] is not True
            or preference["disclosure_version"] != LIVE_BACKGROUND_DISCLOSURE
        ):
            raise DriveReadError("background_preparation_required")
        return preference

    async def get_background(self, *, user_id: str) -> dict:
        def operation(connection):
            current = self.live_active(connection, user_id=user_id)
            preference = self._row(
                connection,
                "SELECT * FROM drive_live_preferences WHERE user_id=:user",
                {"user": user_id},
            )
            enabled = bool(
                preference
                and preference["connection_generation"] == current["connection_generation"]
                and preference["background_enabled"] is True
            )
            return {"enabled": enabled, "revision": preference["revision"] if enabled else 0}

        return await self._transaction(operation)

    async def set_background(self, *, user_id: str, enabled: bool, confirmed: bool) -> dict:
        if confirmed is not True or type(enabled) is not bool:
            raise DriveReadError("confirmation_required")

        def operation(connection):
            current = self.live_active(connection, user_id=user_id)
            result = self._row(
                connection,
                """
                INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled)
                VALUES (:user,:generation,:enabled)
                ON CONFLICT (user_id) DO UPDATE SET
                  connection_generation=EXCLUDED.connection_generation,
                  background_enabled=EXCLUDED.background_enabled,
                  revision=drive_live_preferences.revision+1,
                  updated_at=clock_timestamp()
                RETURNING revision
                """,
                {
                    "user": user_id,
                    "generation": current["connection_generation"],
                    "enabled": enabled,
                },
            )
            return {"enabled": enabled, "revision": result["revision"]}

        result = await self._transaction(operation)
        if enabled:
            await wake_drive_work("suggestions")
        return result
