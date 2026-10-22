"""Fresh per-operation read ports for the local Drive prefix export.

Each lifecycle read joins connection, registry and preparation preference in one
statement. The existing OAuth service still decrypts/validates credentials and
performs refreshes. Snapshots never authorize another operation or owner.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar

from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.external_connector_google_oauth import ExternalConnectorGoogleOAuth
from hushh_mcp.services.external_connector_registry_service import (
    ExternalMcpConnectorDefinition,
)
from hushh_mcp.services.google_drive_adapter import DriveReadError
from scripts.drive_group_local_adapters import LocalCredentialReader

_SNAPSHOT = text("""
    SELECT c.*, to_jsonb(r) AS read_registry, to_jsonb(p) AS read_preference
    FROM user_external_connector_connections c
    LEFT JOIN external_mcp_connectors r ON r.connector_id=c.connector_id
    LEFT JOIN drive_live_preferences p ON p.user_id=c.user_id
    WHERE c.user_id=:owner AND c.connector_id='google_drive'
""")


class _LifecycleReadPort:
    def __init__(self, authority, original):
        self.authority, self.original = authority, original

    def __getattr__(self, name):
        return getattr(self.original, name)

    async def read(self, *, user_id, connector_id, purge=True):
        if not self.authority.active.get():
            return await self.original.read(user_id=user_id, connector_id=connector_id, purge=False)
        if user_id != self.authority.owner or connector_id != "google_drive":
            raise DriveReadError("connection_changed")
        row, registry = await self.authority.snapshot()
        self.authority.registry_row.set(registry)
        return row


class _RegistryReadPort:
    def __init__(self, authority, original):
        self.authority, self.original = authority, original

    async def get_connector(self, connector_id, *, user_id=None, include_inactive=False):
        if not self.authority.active.get():
            return await self.original.get_connector(
                connector_id, user_id=user_id, include_inactive=include_inactive
            )
        registry = self.authority.registry_row.get()
        # Only the immediately preceding fresh lifecycle read may supply this
        # credential lookup. Consume it once; nothing survives the operation.
        if (
            connector_id != "google_drive"
            or user_id is not None
            or include_inactive
            or registry is None
        ):
            raise DriveReadError("connection_changed")
        self.authority.registry_row.set(None)
        return self.original.resolve_definition(
            connector_id, ExternalMcpConnectorDefinition.from_row(registry)
        )


class FreshDriveReadAuthority:
    def __init__(self, oauth, *, owner: str, generation: int, revision: int, engine=None):
        self.owner, self.generation, self.revision = owner, generation, revision
        self.active = ContextVar("drive_fresh_read_active", default=False)
        self.registry_row = ContextVar("drive_fresh_read_registry", default=None)
        self._owns_engine = engine is None
        self.engine = engine or create_engine(
            oauth.lifecycle.db.engine.url,
            isolation_level="AUTOCOMMIT",
            pool_size=15,
            max_overflow=0,
            pool_pre_ping=True,
            pool_recycle=1800,
            pool_timeout=10,
            connect_args={
                "connect_timeout": 5,
                "options": "-c statement_timeout=5000 -c lock_timeout=2000 -c default_transaction_read_only=on",
            },
        )
        self.oauth = ExternalConnectorGoogleOAuth(
            db=oauth.lifecycle.db,
            credentials=oauth.credentials,
            state_codec=oauth.state_codec,
            lifecycle=_LifecycleReadPort(self, oauth.lifecycle),
            registry=_RegistryReadPort(self, oauth.registry),
        )
        self.oauth.current_credential = LocalCredentialReader(self.oauth.current_credential)

    async def snapshot(self):
        def read():
            try:
                # AUTOCOMMIT ends the statement before provider I/O. Timeouts
                # are connection startup options, not repeated SET round trips.
                with self.engine.connect() as connection:
                    found = connection.execute(_SNAPSHOT, {"owner": self.owner}).mappings().first()
                    row = dict(found) if found is not None else None
            except SQLAlchemyError:
                raise DriveReadError("provider_unavailable") from None
            registry = row.pop("read_registry") if row is not None else None
            preference = row.pop("read_preference") if row is not None else None
            DriveLivePreferences.validate_live(row, registry, generation=self.generation)
            preference = DriveLivePreferences.validate_background(
                preference, user_id=self.owner, generation=self.generation
            )
            if preference["revision"] != self.revision:
                raise DriveReadError("background_preparation_required")
            return row, registry

        return await asyncio.to_thread(read)

    @asynccontextmanager
    async def operation(self):
        active = self.active.set(True)
        registry = self.registry_row.set(None)
        try:
            yield
        finally:
            self.registry_row.reset(registry)
            self.active.reset(active)

    def close(self):
        if self._owns_engine:
            self.engine.dispose()
