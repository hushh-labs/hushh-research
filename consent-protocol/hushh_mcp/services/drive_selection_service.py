"""Vault-owner selection boundary. No file execution is exposed to an agent.

Picker grants Google app access, while explicit authenticated confirmation plus
the selected catalog grants ingestion access. Browser Picker events are not
signed evidence; never claim `isAppAuthorized` proves this specific session.
"""

from __future__ import annotations

import asyncio
import os
import re
from datetime import UTC, datetime
from urllib.parse import urlsplit

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_document_store import DriveDocumentStore
from hushh_mcp.services.external_connector_google_oauth import CONNECTOR_ID
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    POLICY_HASH,
    SELECTED_POLICY,
    DriveReadError,
    GoogleDriveAdapter,
    selected_file_ids,
)


class DriveSelectionService:
    def __init__(self, *, oauth=None, store=None, adapter=None):
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.store = store or DriveDocumentStore(db=self.oauth.lifecycle.db)
        self.adapter = adapter or GoogleDriveAdapter()

    async def _current(self, user_id: str):
        if not connector_feature_enabled("google_drive_picker", user_id):
            raise DriveReadError("connector_unavailable")
        connector, _, _ = await self.oauth._configuration()
        if (
            connector.transport_kind != "google_drive_rest"
            or connector.mcp_endpoint != DRIVE_BASE
            or connector.capability_policy != SELECTED_POLICY
        ):
            raise DriveReadError("connector_policy_changed")
        row, credential = await self.oauth.current_credential(user_id=user_id)
        return connector, row, credential

    async def _fence(self, *, user_id: str, generation: int):
        # Local authority only: no token refresh/provider I/O after committing
        # a single-use selection. Registry is rechecked under the store lock.
        if not connector_feature_enabled("google_drive_picker", user_id):
            raise DriveReadError("connector_unavailable")
        current = await self.oauth.lifecycle.read(user_id=user_id, connector_id=CONNECTOR_ID)
        if (
            not current
            or current["status"] not in {"connected", "verifying"}
            or current["connection_generation"] != generation
        ):
            raise DriveReadError("connection_changed")

    async def picker_session(self, *, user_id: str, origin: str) -> dict:
        connector, row, credential = await self._current(user_id)
        allowed_origins = {
            f"{urlsplit(uri).scheme}://{urlsplit(uri).netloc}"
            for uri in connector.registered_redirect_uris
            if not uri.endswith("/api/connectors/oauth/native/callback")
        }
        if origin not in allowed_origins or not origin.startswith("https://"):
            raise DriveReadError("origin_not_registered")
        project_number = credential["oauthClientId"].split("-", 1)[0]
        developer_key = os.getenv("GOOGLE_DRIVE_PICKER_API_KEY", "")
        if not re.fullmatch(r"[0-9]{6,20}", project_number) or not developer_key:
            raise DriveReadError("picker_unavailable")
        # Successful token exchange is not capability verification. Prove the
        # authenticated Drive API works before changing `verifying` to connected.
        await self.adapter.account(access_token=credential["accessToken"])
        await self._fence(user_id=user_id, generation=row["connection_generation"])
        if not await self.oauth.lifecycle.mark_verified(
            user_id=user_id,
            connector_id=CONNECTOR_ID,
            generation=row["connection_generation"],
            version=row["credential_version"],
            policy_hash=POLICY_HASH,
        ):
            raise DriveReadError("connection_changed")
        session = await self.store.start_selection(
            user_id=user_id, generation=row["connection_generation"]
        )
        await self._fence(user_id=user_id, generation=row["connection_generation"])
        expires = datetime.fromisoformat(credential["expiresAt"])
        if expires <= datetime.now(UTC):
            raise DriveReadError("reconnect_required")
        # ONLY this no-store, owner-authenticated endpoint releases the minimum
        # short-lived access credential to the official web Picker. Never persist
        # it in browser state/storage, messages, history, telemetry or tool results.
        return {
            "sessionId": str(session["session_id"]),
            "expiresAt": session["expires_at"].isoformat(),
            "accessToken": credential["accessToken"],
            "tokenExpiresAt": expires.isoformat(),
            "developerKey": developer_key,
            "appId": project_number,
            "origin": origin,
        }

    async def select(self, *, user_id: str, session_id: str, file_ids: list[str]) -> list[dict]:
        ids = selected_file_ids(file_ids)
        _, row, credential = await self._current(user_id)
        generation = row["connection_generation"]
        if not await self.store.selection_is_current(
            user_id=user_id, generation=generation, session_id=session_id
        ):
            raise DriveReadError("selection_expired")
        # Bounded serial admission (25 IDs / 20s total), no hidden scanning or
        # parallel request burst. No partial ingestion if any selected file fails.
        try:
            async with asyncio.timeout(20):
                files = [
                    await self.adapter.get_metadata(
                        file_id=file_id, access_token=credential["accessToken"]
                    )
                    for file_id in ids
                ]
        except TimeoutError:
            raise DriveReadError("provider_unavailable", retryable=True) from None
        await self._fence(user_id=user_id, generation=generation)
        result = await self.store.select(
            user_id=user_id, generation=generation, session_id=session_id, files=files
        )
        await self._fence(user_id=user_id, generation=generation)
        return result

    async def documents(self, *, user_id: str) -> list[dict]:
        # Management still works with feature flags disabled. No provider I/O.
        row = await self.oauth.lifecycle.read(user_id=user_id, connector_id=CONNECTOR_ID)
        if not row:
            return []
        return await self.store.list_documents(
            user_id=user_id, generation=row["connection_generation"]
        )

    async def remove(self, *, user_id: str, document_id: str) -> None:
        row = await self.oauth.lifecycle.read(user_id=user_id, connector_id=CONNECTOR_ID)
        if row:
            await self.store.remove(
                user_id=user_id, generation=row["connection_generation"], document_id=document_id
            )
