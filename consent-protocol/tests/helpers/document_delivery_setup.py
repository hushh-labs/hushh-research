"""Isolated SQL fixtures and ciphertext-only object transport for document delivery."""

import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi import FastAPI, Header
from sqlalchemy import text

from api.routes import document_delivery as routes
from api.routes import drive_request_payments as payment_routes
from api.routes.drive_sharing_owner import _content_owner, _owner
from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
)
from hushh_mcp.services.document_delivery.service import DocumentDeliveryService
from hushh_mcp.services.document_delivery.store import DocumentDeliveryStore
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.google_drive_adapter import DriveMetadata
from tests.drive_postgres_test_support import apply_drive_fixture_migration
from tests.helpers.document_delivery_client import b64
from tests.services.test_drive_document_selection import pick


class CipherObjects:
    """Transport only. PostgreSQL remains the entire domain/lease authority."""

    identity = "1" * 64

    def __init__(self):
        self.objects = {}
        self.sequence = 0

    async def qualify(self):
        return None

    async def put(self, key, value):
        if key in self.objects:
            raise DeliveryError("artifact_write_conflict")
        self.sequence += 1
        generation = str(self.sequence)
        self.objects[key] = (bytes(value), generation)
        return generation

    async def read(self, key, *, limit):
        value, generation = self.objects.get(key, (None, None))
        assert value is None or len(value) <= limit
        return value, generation

    async def remove(self, key, generation):
        current = self.objects.get(key)
        if current is not None:
            assert generation is None or current[1] == generation
            del self.objects[key]
        return True

    async def initiate(self, key, size):
        return "test-session:" + key

    async def send(self, session, key, ciphertext):
        assert session == "test-session:" + key
        return await self.put(key, ciphertext)

    async def session_terminal(self, session, key, size, observed_at):
        return True


def configure_delivery_environment(monkeypatch):
    monkeypatch.setenv("PROTECTED_DOCUMENT_DELIVERY_ENABLED", "true")
    monkeypatch.setenv("DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED", "false")
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "false")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_only_synthetic_delivery")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.invalid")
    clear_runtime_settings_caches()
    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_payment_service.wake_drive_work",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.pkm_payout_service.PkmPayoutService.refresh_account",
        AsyncMock(
            return_value={"readiness": {"ready": True}, "stripe_account_id": "acct_test_owner"}
        ),
    )


def seed_delivery_registry(sharing, public):
    with sharing.db.engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS actor_profiles(user_id TEXT PRIMARY KEY)"
        )
        connection.exec_driver_sql(
            "INSERT INTO actor_profiles VALUES('recipient') ON CONFLICT DO NOTHING"
        )
        # Canonical registry DDL; unrelated KYC workflow columns are outside this fixture.
        from pathlib import Path

        registry = (
            (Path(__file__).parents[2] / "db/migrations/050_one_kyc_client_connector_registry.sql")
            .read_text()
            .split("ALTER TABLE one_kyc_workflows", 1)[0]
        )
        connection.exec_driver_sql((registry + "COMMIT;").replace("%", "%%"))
        apply_drive_fixture_migration(connection, "424_protected_one_document_delivery.sql")
        apply_drive_fixture_migration(connection, "424_protected_one_document_delivery.sql")
        connection.execute(
            text("""INSERT INTO one_kyc_client_connectors
          (user_id,connector_key_id,connector_public_key,public_key_fingerprint)
          VALUES('recipient','key-test',:public,:legacy)"""),
            {"public": public, "legacy": hashlib.sha256(public.encode()).hexdigest()},
        )
        connection.execute(
            text("""INSERT INTO stripe_owner_payout_accounts
          (user_id,stripe_account_id,stripe_mode,details_submitted,payouts_enabled,account_ready)
          VALUES('owner','acct_test_owner','test',true,true,true)""")
        )


@pytest.fixture
async def delivery_system(sharing, monkeypatch):
    configure_delivery_environment(monkeypatch)
    private = X25519PrivateKey.generate()
    public = b64(
        private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
    )
    seed_delivery_registry(sharing, public)
    pdf = DriveMetadata(
        "private-pdf-source",
        "Private statement.pdf",
        "application/pdf",
        "1",
        "2026-10-20T00:00:00Z",
        128,
        None,
    )
    await pick(sharing, [pdf])
    store = DocumentDeliveryStore(
        db=sharing.db, cipher=sharing.cipher, sharing_cipher=sharing.sharing_cipher
    )
    service = DocumentDeliveryService(store=store, objects=CipherObjects())
    from tests.services.test_drive_request_payment import _CommerceStripe

    provider = _CommerceStripe(str(uuid4()))
    payment = DriveRequestPaymentService(
        db=sharing.db, stripe_api=provider, document_delivery=service
    )
    return SimpleNamespace(
        store=store,
        service=service,
        private=private,
        public=public,
        db=sharing.db,
        payment=payment,
        provider=provider,
    )


@pytest.fixture
def delivery_app(delivery_system, monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    app.include_router(payment_routes.router)
    app.include_router(payment_routes.webhook_router)
    monkeypatch.setattr(routes, "_service", lambda: delivery_system.service)
    monkeypatch.setattr(payment_routes, "_service", lambda: delivery_system.payment)

    async def actor(authorization: str = Header(default="recipient")):
        async def require_current():
            return None

        return SimpleNamespace(user_id=authorization, require_current=require_current)

    app.dependency_overrides[_owner] = actor
    app.dependency_overrides[_content_owner] = actor

    async def payment_actor(authorization: str = Header(default="recipient")):
        return authorization.removeprefix("Bearer ")

    app.dependency_overrides[payment_routes.require_firebase_auth_read_only] = payment_actor
    return app
